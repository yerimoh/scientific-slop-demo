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
        self.model = model or os.environ.get("SCISLOP_MODEL", DEFAULT_MODEL)
        self.base_url = (base_url or os.environ.get("SCISLOP_LLM_BASE_URL", DEFAULT_BASE)).rstrip("/")
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY") or os.environ.get("SCISLOP_LLM_API_KEY")
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
        return bool(self.api_key) or "openrouter.ai" not in self.base_url

    def describe(self) -> dict:
        return {"model": self.model, "provider": "OpenRouter" if "openrouter.ai" in self.base_url else self.base_url}

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
            raise LLMError("No OPENROUTER_API_KEY configured")
        key = self._key(messages, schema, run)
        path = os.path.join(self.cache_dir, key[:2], key + ".json")
        if os.path.exists(path):
            self.cached += 1
            with open(path) as f:
                return json.load(f)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": name, "strict": True, "schema": schema}},
        }
        if "openrouter.ai" in self.base_url:
            body["reasoning"] = {"effort": self.reasoning}
            body["seed"] = run
        else:
            body["temperature"] = 0.0 if run == 0 else 0.7
            body["seed"] = run
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
