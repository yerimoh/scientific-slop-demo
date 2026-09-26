"""OpenAI-compatible chat client (OpenRouter by default) with a disk cache.

Every call is cached under a hash of (model, messages, schema, run), as in the paper, so re-scoring
the same paper is free and deterministic. Structured outputs keep every label a forced choice.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
from typing import Any, Optional

import httpx

DEFAULT_MODEL = "openai/gpt-5.6-luna"
DEFAULT_BASE = "https://openrouter.ai/api/v1"


class LLMError(RuntimeError):
    pass


class LLM:
    def __init__(self, model: Optional[str] = None, api_key: Optional[str] = None, base_url: Optional[str] = None,
                 cache_dir: Optional[str] = None, reasoning: Optional[str] = None, max_parallel: int = 10):
        # Provider, in order of preference: a LiteLLM proxy gateway (e.g. the UMN AI gateway), a custom
        # OpenAI-compatible endpoint (e.g. local vLLM), then OpenRouter.
        litellm_base = os.environ.get("LITELLM_PROXY_API_BASE")
        if base_url is None and litellm_base:
            self.provider = "litellm"
            self.base_url = litellm_base.rstrip("/")
            if not self.base_url.endswith("/v1"):
                self.base_url += "/v1"
            self.api_key = api_key or os.environ.get("LITELLM_PROXY_API_KEY")
        elif base_url or os.environ.get("SCISLOP_LLM_BASE_URL"):
            self.provider = "custom"
            self.base_url = (base_url or os.environ["SCISLOP_LLM_BASE_URL"]).rstrip("/")
            self.api_key = api_key or os.environ.get("SCISLOP_LLM_API_KEY")
        else:
            self.provider = "openrouter"
            self.base_url = DEFAULT_BASE
            self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        self.model = model or os.environ.get("SCISLOP_MODEL", DEFAULT_MODEL)
        if self.provider == "litellm" and self.model.startswith("openai/"):
            self.model = self.model[len("openai/"):]     # LiteLLM model names carry no provider prefix
        self.reasoning = reasoning or os.environ.get("SCISLOP_REASONING", "low")
        self.cache_dir = cache_dir or os.environ.get(
            "SCISLOP_CACHE", os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "llm_cache"))
        os.makedirs(self.cache_dir, exist_ok=True)
        self._sem = asyncio.Semaphore(max_parallel)
        self.calls = 0
        self.cached = 0
        self.tokens = {"prompt": 0, "completion": 0}

    @property
    def available(self) -> bool:
        return bool(self.api_key) or self.provider == "custom"

    def describe(self) -> dict:
        name = {"litellm": "UMN AI gateway (LiteLLM)" if "umn.edu" in self.base_url else "LiteLLM gateway",
                "openrouter": "OpenRouter"}.get(self.provider, self.base_url)
        return {"model": self.model, "provider": name}

    @staticmethod
    def image_part(path_or_bytes, mime: str = "image/png") -> dict:
        data = path_or_bytes if isinstance(path_or_bytes, (bytes, bytearray)) else open(path_or_bytes, "rb").read()
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}}

    def _key(self, messages, schema, run) -> str:
        blob = json.dumps({"m": self.model, "msg": messages, "s": schema, "r": run}, sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()

    async def json(self, messages: list[dict], schema: dict, name: str, run: int = 0,
                   max_tokens: int = 8000) -> dict:
        if not self.available:
            raise LLMError("No LLM key configured (LITELLM_PROXY_API_KEY or OPENROUTER_API_KEY)")
        key = self._key(messages, schema, run)
        path = os.path.join(self.cache_dir, key[:2], key + ".json")
        if os.path.exists(path):
            self.cached += 1
            with open(path) as f:
                return json.load(f)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": name, "strict": True, "schema": schema}},
        }
        if self.provider == "openrouter":
            body.update({"max_tokens": max_tokens, "reasoning": {"effort": self.reasoning}, "seed": run})
        elif self.provider == "litellm":
            # OpenAI chat-completions shape: reasoning models take max_completion_tokens and reasoning_effort
            body.update({"max_completion_tokens": max_tokens, "reasoning_effort": self.reasoning, "seed": run})
        else:
            body.update({"max_tokens": max_tokens, "temperature": 0.0 if run == 0 else 0.7, "seed": run})
        extra = os.environ.get("SCISLOP_LLM_EXTRA")
        if extra:
            body.update(json.loads(extra))
        headers = {"Content-Type": "application/json", "X-Title": "Science Slop Index",
                   "HTTP-Referer": "https://github.com/scislop"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        last = None
        async with self._sem:
            for attempt in range(4):
                try:
                    async with httpx.AsyncClient(timeout=180) as client:
                        r = await client.post(f"{self.base_url}/chat/completions", headers=headers, json=body)
                    if r.status_code in (429, 500, 502, 503, 504):
                        last = f"HTTP {r.status_code}: {r.text[:200]}"
                        await asyncio.sleep(2 ** attempt + 0.5)
                        continue
                    if r.status_code != 200:
                        raise LLMError(f"HTTP {r.status_code}: {r.text[:300]}")
                    d = r.json()
                    if "error" in d:
                        raise LLMError(str(d["error"])[:300])
                    content = d["choices"][0]["message"].get("content") or ""
                    out = _parse_json(content)
                    self.calls += 1
                    u = d.get("usage") or {}
                    self.tokens["prompt"] += u.get("prompt_tokens", 0) or 0
                    self.tokens["completion"] += u.get("completion_tokens", 0) or 0
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    with open(path, "w") as f:
                        json.dump(out, f)
                    return out
                except (httpx.HTTPError, ValueError, KeyError) as e:
                    last = f"{type(e).__name__}: {e}"
                    await asyncio.sleep(2 ** attempt + 0.5)
        raise LLMError(last or "LLM call failed")


def _parse_json(content: str) -> dict:
    content = content.strip()
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
    # reasoning models served locally may prepend a think block
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            raise ValueError("model returned no JSON")
        return json.loads(m.group(0))
