"""Run the six measures on one paper and assemble the Science Slop Index report."""
from __future__ import annotations

import asyncio
import os
import time
import traceback
from typing import Awaitable, Callable, Optional

from .document import Document
from .llm import LLM, LLMError
from .measures import (META, PLANES, aggregate, argument_graph, citation_isolation, cross_section_references,
                       evidence_gap, figure_exposition, macro_redundancy)

Emit = Callable[[str, dict], Awaitable[None] | None]

ORDER = ["cross_refs", "macro_redundancy", "argument_graph", "citation_isolation", "figure_exposition",
         "evidence_gap"]


def read_document(kind: str, path: str) -> Document:
    if kind == "latex":
        from .latex import read_latex
        return read_latex(path)
    from .pdf import read_pdf
    return read_pdf(path)


def document_summary(doc: Document, meta: Optional[dict] = None) -> dict:
    fidelity = ("LaTeX source: labels, references and citations are read directly." if doc.source == "latex"
                else "PDF reconstruction: headings, captions, printed references and citations are recovered "
                     "from the layout, as the paper does for PDF-only submissions.")
    return {
        "title": doc.title or (meta or {}).get("fallback_title") or "Untitled paper",
        "source": doc.source,
        "fidelity": fidelity,
        "route": (meta or {}).get("route"),
        "url": (meta or {}).get("url"),
        "outline": doc.outline(),
        "stats": doc.stats,
        "warnings": doc.warnings,
    }


async def _call(emit: Optional[Emit], kind: str, payload: dict):
    if emit is None:
        return
    r = emit(kind, payload)
    if asyncio.iscoroutine(r):
        await r


async def analyze_document(doc: Document, llm: LLM, out_dir: str, emit: Optional[Emit] = None,
                           fig_index: Optional[int] = None, meta: Optional[dict] = None) -> dict:
    t0 = time.time()
    summary = document_summary(doc, meta)
    await _call(emit, "document", summary)
    measures: dict[str, dict] = {}
    # render every candidate method figure now, so the source files are not needed afterwards
    from .measures import method_figure_candidates, render_figure

    def _prerender():
        for c in method_figure_candidates(doc)[:16]:
            try:
                render_figure(doc, c["index"], out_dir)
            except Exception:
                pass
    await asyncio.to_thread(_prerender)

    async def done(r: dict):
        measures[r["key"]] = r
        await _call(emit, "measure", r)

    # deterministic measures first: they are instant
    for key, fn in (("cross_refs", cross_section_references), ("macro_redundancy", macro_redundancy),
                    ("citation_isolation", citation_isolation), ("evidence_gap", evidence_gap)):
        await _call(emit, "running", {"key": key})
        try:
            r = fn(doc)
        except Exception as e:  # never let one measure sink the report
            r = {"key": key, **{k: v for k, v in META[key].items()}, "status": "error", "score": None,
                 "instances": [], "notes": [f"{type(e).__name__}: {e}"], "details": {}}
            traceback.print_exc()
        await done(r)

    async def run_llm(key, coro):
        await _call(emit, "running", {"key": key})
        try:
            r = await coro
        except LLMError as e:
            r = {"key": key, "name": META[key]["name"], "plane": META[key]["plane"], "method": "llm",
                 "status": "error", "score": None, "instances": [], "details": {},
                 "notes": [f"LLM call failed: {e}"]}
        except Exception as e:
            traceback.print_exc()
            r = {"key": key, "name": META[key]["name"], "plane": META[key]["plane"], "method": "llm",
                 "status": "error", "score": None, "instances": [], "details": {},
                 "notes": [f"{type(e).__name__}: {e}"]}
        await done(r)

    await asyncio.gather(
        run_llm("argument_graph", argument_graph(doc, llm)),
        run_llm("figure_exposition", figure_exposition(doc, llm, out_dir, fig_index=fig_index)),
    )
    agg = aggregate(measures)
    result = {
        "version": "0.1",
        "document": summary,
        "index": agg,
        "measures": [measures[k] for k in ORDER if k in measures],
        "planes": PLANES,
        "engine": {"llm": llm.describe(), "llm_available": llm.available, "llm_calls": llm.calls,
                   "llm_cached": llm.cached, "seconds": round(time.time() - t0, 2)},
    }
    return result


async def rerun_figure(doc: Document, result: dict, llm: LLM, out_dir: str, fig_index: int) -> dict:
    r = await figure_exposition(doc, llm, out_dir, fig_index=fig_index)
    ms = {m["key"]: m for m in result["measures"]}
    ms["figure_exposition"] = r
    result["measures"] = [ms[k] for k in ORDER if k in ms]
    result["index"] = aggregate(ms)
    return result
