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


Progress = Callable[[float, str], None]


def attach_pdf(result: dict, doc: Document, out_dir: str, view_pdf: Optional[str]) -> None:
    """Locate the findings on the paper's PDF, then write the highlighted PDF and the thumbnail.

    The PDF is copied into the report folder as paper.pdf so pages can be rendered later."""
    import shutil

    from .highlight import annotated_pdf, locate_findings, thumbnail
    os.makedirs(out_dir, exist_ok=True)
    keep = os.path.join(out_dir, "paper.pdf")
    if view_pdf and os.path.abspath(view_pdf) != os.path.abspath(keep):
        shutil.copyfile(view_pdf, keep)
    if not os.path.exists(keep):
        result["pdf"] = {"available": False,
                         "reason": "No PDF of this paper was available (LaTeX source only). Upload the PDF, or an "
                                   "archive that includes the compiled PDF, to see the findings on the paper."}
        return
    try:
        info = locate_findings(result, doc, keep, pdf_doc=doc if doc.source == "pdf" else None)
        result["pdf"] = info
        with open(os.path.join(out_dir, "highlighted.pdf"), "wb") as f:
            f.write(annotated_pdf(keep, result))
        with open(os.path.join(out_dir, "thumb.png"), "wb") as f:
            f.write(thumbnail(keep))
    except Exception as e:
        traceback.print_exc()
        result["pdf"] = {"available": False, "reason": f"Could not place the findings on the PDF ({type(e).__name__})."}


async def analyze_document(doc: Document, llm: LLM, out_dir: str, emit: Optional[Emit] = None,
                           fig_index: Optional[int] = None, meta: Optional[dict] = None,
                           view_pdf: Optional[str] = None, progress: Optional[Progress] = None) -> dict:
    t0 = time.time()
    prog = progress or (lambda pct, label: None)
    summary = document_summary(doc, meta)
    await _call(emit, "document", summary)
    measures: dict[str, dict] = {}
    # render every candidate method figure now, so the source files are not needed afterwards
    from .measures import EXPECTED_CLAIMS, method_figure_candidates, render_figure

    prog(22, "Rendering figures")

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
    for k, (key, fn) in enumerate((("cross_refs", cross_section_references), ("macro_redundancy", macro_redundancy),
                                   ("citation_isolation", citation_isolation), ("evidence_gap", evidence_gap))):
        prog(25 + 4 * k, f"Measuring {META[key]['name'].lower()}")
        await _call(emit, "running", {"key": key})
        try:
            r = fn(doc)
        except Exception as e:  # never let one measure sink the report
            r = {"key": key, **{k2: v for k2, v in META[key].items()}, "status": "error", "score": None,
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

    # language-model measures: progress follows the calls that have finished
    llm.expected = 3 + EXPECTED_CLAIMS + 3
    llm.on_progress = lambda: prog(42 + 43 * min(1.0, llm.done_calls / max(llm.expected, llm.done_calls, 1)),
                                   f"Reading claims and the method figure ({llm.done_calls} of {max(llm.expected, llm.done_calls)} model calls)")
    prog(42, "Reading claims and the method figure")
    await asyncio.gather(
        run_llm("argument_graph", argument_graph(doc, llm)),
        run_llm("figure_exposition", figure_exposition(doc, llm, out_dir, fig_index=fig_index)),
    )
    llm.on_progress = None
    agg = aggregate(measures)
    result = {
        "version": "0.2",
        "document": summary,
        "index": agg,
        "measures": [measures[k] for k in ORDER if k in measures],
        "planes": PLANES,
        "engine": {"llm": llm.describe(), "llm_available": llm.available, "llm_calls": llm.calls,
                   "llm_cached": llm.cached, "seconds": 0},
    }
    prog(88, "Highlighting the findings on the paper")
    await asyncio.to_thread(attach_pdf, result, doc, out_dir, view_pdf)
    result["engine"]["seconds"] = round(time.time() - t0, 2)
    prog(100, "Done")
    return result


async def rerun_figure(doc: Document, result: dict, llm: LLM, out_dir: str, fig_index: int) -> dict:
    r = await figure_exposition(doc, llm, out_dir, fig_index=fig_index)
    ms = {m["key"]: m for m in result["measures"]}
    ms["figure_exposition"] = r
    result["measures"] = [ms[k] for k in ORDER if k in ms]
    result["index"] = aggregate(ms)
    if (result.get("pdf") or {}).get("available"):
        await asyncio.to_thread(attach_pdf, result, doc, out_dir, None)
    return result
