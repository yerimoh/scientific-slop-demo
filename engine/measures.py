"""The six scientific slop measures (Table 1 / Appendix A) and the aggregate score (Eq. 2).

Each measure returns a dict:
  key, name, plane, method (rule | llm), status (done | na | error | skipped),
  score s_j(p) in [0, 1] or None, num / den (Eq. 1), unit, weak flag, instances (located units that
  show the pattern, with section / sentence positions for the paper map), and details for the UI.
"""
from __future__ import annotations

import asyncio
import os
import re
from collections import Counter, defaultdict
from typing import Optional

from .document import Document
from .llm import LLM, LLMError
from .text import (DEICTIC_WORKS, FIRST_PERSON, RELATION_CUES, SENTENCE_INITIAL_CUES, tokenize)

PLANES = {
    "structure": ["cross_refs", "macro_redundancy"],
    "argument": ["argument_graph", "citation_isolation"],
    "artifacts": ["figure_exposition", "evidence_gap"],
}

# Registry text (Table 1) and the per-measure discrimination reported on SciSlopBench (Table 3).
META = {
    "cross_refs": dict(
        name="Cross-section references", plane="structure", method="rule", unit="objects",
        what="Sections and labeled objects that no other section ever refers to.",
        numerator="objects never referenced outside their own section", denominator="all objects",
        one="No object is ever referred to from another section.", pairacc=0.905, auroc=0.895),
    "macro_redundancy": dict(
        name="Macro redundancy", plane="structure", method="rule", unit="sentences",
        what="Later sections repeat earlier material instead of developing the argument.",
        numerator="sentences half or more copied as 8-grams from an earlier section", denominator="all sentences",
        one="Every sentence mostly repeats earlier sections.", pairacc=0.723, auroc=0.727),
    "argument_graph": dict(
        name="Argument graph", plane="argument", method="llm", unit="key claims",
        what="Key claims in the Introduction stated before the context that supports them.",
        numerator="shallow claims: nothing earlier leads up to them", denominator="all key claims",
        one="The argument is flat. Every claim stands alone with no build-up behind it.", pairacc=0.586,
        auroc=0.584),
    "citation_isolation": dict(
        name="Citation isolation", plane="argument", method="rule", unit="citing sentences",
        what="Prior work cited without relating it to any other work.",
        numerator="citations not grouped, compared, or related to other works", denominator="all citations",
        one="Every citation stands alone.", pairacc=0.793, auroc=0.782),
    "figure_exposition": dict(
        name="Figure exposition", plane="artifacts", method="llm", unit="content kinds",
        what="Method diagrams crowded with material that belongs in the text.",
        numerator="content types not needed to show the method", denominator="all content types in the figure",
        one="Nothing in the figure shows the method itself.", pairacc=0.809, auroc=0.786),
    "evidence_gap": dict(
        name="Evidence gap", plane="artifacts", method="rule", unit="paper",
        what="Aggregate results reported without a single concrete input, output, or case.",
        numerator="papers showing no concrete input, output, or case", denominator="all papers",
        one="The paper gives no concrete example at all.", pairacc=0.764, auroc=0.765),
}


def _base(key: str) -> dict:
    m = META[key]
    return {"key": key, "name": m["name"], "plane": m["plane"], "method": m["method"], "unit": m["unit"],
            "what": m["what"], "numerator_def": m["numerator"], "denominator_def": m["denominator"],
            "one_means": m["one"], "paper_pairacc": m["pairacc"], "paper_auroc": m["auroc"],
            "status": "done", "score": None, "num": 0, "den": 0, "weak": False, "notes": [],
            "instances": [], "details": {}}


def _na(r: dict, why: str) -> dict:
    r["status"] = "na"
    r["notes"].append(why)
    return r


def _sec_title(doc: Document, idx: int) -> str:
    try:
        s = doc.section(idx)
    except KeyError:
        return "?"
    return (f"§{s.number} " if s.number else "") + s.title


# ============================================================================ Structure

def cross_section_references(doc: Document) -> dict:
    r = _base("cross_refs")
    objs = doc.objects
    if not objs or not doc.sections:
        return _na(r, "No body sections were recovered.")
    by_id = {o.id: o for o in objs}
    first = doc.sections[0].idx
    # roadmap: the longest run of forward pointers to later sections inside the first section
    first_ptrs = sorted((p for p in doc.pointers if p.src == first), key=lambda p: p.pos)
    run, best = [], []
    for p in first_ptrs:
        o = by_id.get(p.target)
        if o is not None and o.kind == "section" and o.home > first:
            run.append(p)
        else:
            if len(run) > len(best):
                best = run
            run = []
    if len(run) > len(best):
        best = run
    if len(best) >= 2:
        for p in best:
            p.roadmap = True
    referenced_from: dict[str, set[int]] = defaultdict(set)
    own_refs: Counter = Counter()
    appendix_ptrs = 0
    for p in doc.pointers:
        if p.target.startswith("appendix:"):
            appendix_ptrs += 1
            continue
        o = by_id.get(p.target)
        if o is None or p.roadmap:
            continue
        if p.src != o.home:
            referenced_from[o.id].add(p.src)
        else:
            own_refs[o.id] += 1
    flagged = [o for o in objs if not referenced_from.get(o.id)]
    r["num"], r["den"] = len(flagged), len(objs)
    r["score"] = len(flagged) / len(objs)
    for o in flagged:
        r["instances"].append({
            "label": o.display or o.id, "kind": o.kind, "id": o.id, "section": o.home,
            "section_title": _sec_title(doc, o.home), "caption": (o.caption or "")[:240],
            "own_section_refs": own_refs.get(o.id, 0),
            "text": f"{o.display or o.id} is never referred to from outside {_sec_title(doc, o.home)}"
                    + (f" (referenced {own_refs[o.id]}× inside its own section)" if own_refs.get(o.id) else "."),
        })
    r["details"] = {
        "objects": [{"id": o.id, "label": o.display or o.id, "kind": o.kind, "home": o.home,
                     "from": sorted(referenced_from.get(o.id, set())), "own": own_refs.get(o.id, 0)} for o in objs],
        "edges": [{"src": p.src, "target": p.target, "via": p.via, "roadmap": p.roadmap}
                  for p in doc.pointers if not p.target.startswith("appendix:") and p.target in by_id],
        "appendix_pointers": appendix_ptrs,
        "roadmap_pointers": len(best) if len(best) >= 2 else 0,
    }
    if appendix_ptrs:
        r["notes"].append(f"{appendix_ptrs} pointer(s) into the appendix are recorded apart and do not count.")
    if len(best) >= 2:
        r["notes"].append(f"A roadmap of {len(best)} forward pointers in the first section is recorded apart.")
    return r


def macro_redundancy(doc: Document, n: int = 8, tau: float = 0.5) -> dict:
    r = _base("macro_redundancy")
    secs = doc.prose_sections()
    first_seen: dict[tuple, tuple[int, int, int]] = {}   # ngram -> (section idx, global sentence no, local no)
    units = 0
    g = 0
    sent_index: dict[int, tuple[int, int]] = {}
    for sec in secs:
        for li, sent in enumerate(sec.sentences):
            toks = tokenize(sent.text)
            words = [t[0] for t in toks]
            sent_index[g] = (sec.idx, li)
            covered = [False] * len(words)
            sources: Counter = Counter()
            src_sent: dict[int, int] = {}
            if len(words) >= n:
                units += 1
                for p in range(len(words) - n + 1):
                    gram = tuple(words[p:p + n])
                    fs = first_seen.get(gram)
                    if fs and fs[0] != sec.idx and fs[1] < g:
                        for k in range(p, p + n):
                            covered[k] = True
                        sources[fs[0]] += 1
                        src_sent.setdefault(fs[0], fs[1])
                cov = sum(covered) / len(words)
                if cov >= tau:
                    spans = []
                    k = 0
                    while k < len(words):
                        if covered[k]:
                            a = k
                            while k < len(words) and covered[k]:
                                k += 1
                            spans.append([toks[a][1], toks[k - 1][2]])
                        else:
                            k += 1
                    src = sources.most_common(1)[0][0]
                    ssec, sli = sent_index[src_sent[src]]
                    r["instances"].append({
                        "section": sec.idx, "section_title": _sec_title(doc, sec.idx), "sentence": li,
                        "text": sent.text, "coverage": round(cov, 3), "highlights": spans,
                        "source_section": src, "source_title": _sec_title(doc, src),
                        "source_text": doc.section(ssec).sentences[sli].text,
                    })
            for p in range(len(words) - n + 1):
                gram = tuple(words[p:p + n])
                if gram not in first_seen:
                    first_seen[gram] = (sec.idx, g, li)
            g += 1
    if units == 0:
        return _na(r, "No sentence of eight or more tokens was recovered.")
    r["num"], r["den"] = len(r["instances"]), units
    r["score"] = r["num"] / units
    r["details"] = {"n": n, "tau": tau}
    return r


# ============================================================================ Argument

_NAME_TOKEN = re.compile(r"(?:^|[\s(“\"])((?:[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*|[A-Z]{2,}[a-z0-9]*)(?:[-‑][A-Za-z0-9]+)*)"
                         r"(?:\s+(?:et al\.?|model|method|framework|reviewer|detector))?\s*(?:\([^)]*\))?\s*$")
_STOP_NAMES = {"AI", "LLM", "LLMs", "NLP", "ML", "RL", "API", "GPU", "GPUs", "SOTA", "CNN", "RNN", "USA", "US",
               "UK", "EU", "PDF", "URL", "SQL", "HTML", "JSON", "CPU", "TPU", "IID", "OOD", "QA", "IR", "CV", "NN",
               "DNN", "MLP", "LM", "LMs", "VLM", "VLMs", "MLLM", "MLLMs", "RAG", "KV", "FPR", "TPR", "AUC",
               "AUROC", "F1", "IEEE", "ACM", "ICLR", "NeurIPS", "ICML", "ACL", "EMNLP", "CVPR", "ECCV", "ICCV",
               "AAAI", "IJCAI", "NAACL", "COLING", "KDD", "WWW", "SIGIR", "arXiv"}


def _lexicon(doc: Document, sections) -> dict[str, set[str]]:
    lex: dict[str, set[str]] = defaultdict(set)
    for key, names in (doc.work_names or {}).items():
        for nm in names:
            if nm and nm not in _STOP_NAMES and len(nm) >= 3:
                lex[nm].add(key)
    for sec in sections:
        for sent in sec.sentences:
            parts = sent.text.split("[cite]")
            for gi, grp in enumerate(sent.cites):
                if gi >= len(parts):
                    break
                before = parts[gi][-60:]
                m = _NAME_TOKEN.search(before)
                if m and m.group(1) not in _STOP_NAMES:
                    lex[m.group(1)].update(grp)
            # clause-initial names with a single cite in the clause ("DetectGPT measures ... [cite], ...")
            for clause in re.split(r"[,;]|\band\b", sent.text):
                if clause.count("[cite]") != 1:
                    continue
                mm = re.match(r"\s*(?:the\s+)?((?:[A-Z][A-Za-z0-9]*[A-Z0-9][A-Za-z0-9]*|[A-Z]{2,}[a-z0-9]*)(?:[-‑][A-Za-z0-9]+)*)\b",
                              clause)
                if mm and mm.group(1) not in _STOP_NAMES:
                    idx = sent.text.split("[cite]")
                    # find which cite group this clause holds
                    pos = sent.text.find(clause)
                    gi = sent.text[:pos + len(clause)].count("[cite]") - 1
                    if 0 <= gi < len(sent.cites):
                        lex[mm.group(1)].update(sent.cites[gi])
    return lex


def citation_isolation(doc: Document) -> dict:
    r = _base("citation_isolation")
    idxs = ([doc.intro_idx] if doc.intro_idx is not None else []) + [i for i in doc.related_idx if i != doc.intro_idx]
    secs = [doc.section(i) for i in idxs]
    if not secs:
        return _na(r, "No Introduction or Related Work section was recovered.")
    lex = _lexicon(doc, secs)
    units = weave = 0
    reasons = Counter()
    for sec in secs:
        prev_cites = False
        for li, sent in enumerate(sec.sentences):
            keys = set(sent.keys)
            if not keys:
                prev_cites = False
                continue
            units += 1
            outside = sent.text.replace("[cite]", " ")
            why = None
            if len(keys) >= 2:
                why = "cites two or more works together"
            else:
                for nm, nkeys in lex.items():
                    if nkeys - keys and re.search(r"(?<![A-Za-z0-9])" + re.escape(nm) + r"(?![A-Za-z0-9])", outside):
                        why = f"names another work ({nm})"
                        break
                if why is None and not FIRST_PERSON.search(sent.text):
                    if SENTENCE_INITIAL_CUES.match(sent.text.strip()) and prev_cites:
                        why = "links to the previous work by a relational cue"
                    elif RELATION_CUES.search(sent.text) and DEICTIC_WORKS.search(sent.text):
                        why = "relates the work to other works by a cue"
            if why:
                weave += 1
                reasons[why.split(" (")[0]] += 1
            else:
                r["instances"].append({
                    "section": sec.idx, "section_title": _sec_title(doc, sec.idx), "sentence": li,
                    "text": sent.text, "keys": sorted(keys),
                    "why": "Cites one work and relates it to nothing else"
                           + (" (it is related only to the present paper)." if FIRST_PERSON.search(sent.text) else "."),
                })
            prev_cites = True
    if units == 0:
        return _na(r, "The Introduction and Related Work contain no citing sentence.")
    r["num"], r["den"] = len(r["instances"]), units
    r["score"] = r["num"] / units
    r["weak"] = units < 8
    if r["weak"]:
        r["notes"].append("Fewer than eight citing sentences: the score is flagged weak.")
    r["notes"].append("The relational cue list is our reconstruction of the paper's frozen list.")
    r["details"] = {"sections": [_sec_title(doc, i) for i in idxs], "woven": weave, "reasons": dict(reasons),
                    "lexicon_size": len(lex)}
    return r


# ---------------------------------------------------------------------------- Argument graph (LLM)

ARG_LABELS = ["superiority", "prior_limitation", "design_choice", "other"]
_LABEL_SCHEMA = {
    "type": "object",
    "properties": {"labels": {"type": "array", "items": {
        "type": "object",
        "properties": {"i": {"type": "integer"}, "label": {"type": "string", "enum": ARG_LABELS}},
        "required": ["i", "label"], "additionalProperties": False}}},
    "required": ["labels"], "additionalProperties": False,
}
_LABEL_PROMPT = """You label the sentences of a scientific paper's Introduction. For each numbered sentence choose exactly one label:
- superiority: asserts that the paper's own method, result, or contribution is better, stronger, first, or more effective than alternatives, or states a strong positive finding of this paper.
- prior_limitation: asserts that existing methods, prior work, or current practice have a shortcoming, gap, or failure.
- design_choice: states or justifies a choice in how the paper's own approach, study, or benchmark is built ("we use X because ...", "we therefore adopt ...", "rather than X, we ...").
- other: background, definitions, questions, roadmap, headings, or anything that is not one of the three claims above.

Return a label for every sentence number.

INTRODUCTION:
{sentences}"""
_SUPPORT_PROMPT = """Here is a claim from the Introduction of a scientific paper, followed by other sentences from the same Introduction, listed in random order.

CLAIM: {claim}

Which ONE of the listed sentences, if a reader had just read it, would make the claim most expected and most plausible? Pick the sentence that the claim most directly rests on: the observation, limitation, evidence, or reasoning behind it.

SENTENCES:
{candidates}"""


def _support_schema(ids: list[str]) -> dict:
    return {"type": "object", "properties": {"choice": {"type": "string", "enum": ids}},
            "required": ["choice"], "additionalProperties": False}


async def _support_for(claim: int, sents: list[str], llm: LLM, run: int = 0) -> Optional[int]:
    """PMI stand-in: the candidate contexts are shown in a shuffled order with neutral ids, so the choice
    depends on the (context, claim) pair only, as a PMI score does, and never on sentence position."""
    import random
    others = [j for j in range(1, len(sents) + 1) if j != claim and len(sents[j - 1].split()) >= 3]
    if not others:
        return None
    order = others[:]
    random.Random(f"{claim}/{len(sents)}/{run}").shuffle(order)
    ids = [f"S{k + 1}" for k in range(len(order))]
    cands = "\n".join(f"{i}: {sents[j - 1]}" for i, j in zip(ids, order))
    msgs = [{"role": "user", "content": _SUPPORT_PROMPT.format(claim=sents[claim - 1], candidates=cands)}]
    out = await llm.json(msgs, _support_schema(ids), "claim_support", run=run, max_tokens=4000)
    ch = out.get("choice")
    return order[ids.index(ch)] if ch in ids else None


def _majority(values: list, fallback):
    vals = [v for v in values if v is not None]
    if not vals:
        return fallback
    c = Counter(vals).most_common()
    if len(c) == 1 or c[0][1] > c[1][1]:
        return c[0][0]
    return vals[0]


async def argument_graph(doc: Document, llm: LLM, runs: int = 3) -> dict:
    r = _base("argument_graph")
    if doc.intro_idx is None:
        return _na(r, "No Introduction was recovered.")
    sents = [s.text for s in doc.section(doc.intro_idx).sentences]
    if len(sents) < 4:
        return _na(r, "The Introduction has fewer than four sentences.")
    if not llm.available:
        r["status"] = "skipped"
        r["notes"].append("Needs a language model: set LITELLM_PROXY_API_KEY (or OPENROUTER_API_KEY).")
        return r
    numbered = "\n".join(f"[{i + 1}] {t}" for i, t in enumerate(sents))
    msgs = [{"role": "user", "content": _LABEL_PROMPT.format(sentences=numbered)}]
    outs = await asyncio.gather(*[llm.json(msgs, _LABEL_SCHEMA, "intro_labels", run=k) for k in range(runs)])
    votes: dict[int, list] = defaultdict(list)
    for o in outs:
        for it in o.get("labels", []):
            if isinstance(it.get("i"), int) and 1 <= it["i"] <= len(sents):
                votes[it["i"]].append(it.get("label"))
    labels = {i: _majority(votes.get(i, []), "other") for i in range(1, len(sents) + 1)}
    claims = [i for i, l in labels.items() if l in ("superiority", "prior_limitation", "design_choice")]
    r["details"] = {"labels": labels, "sentences": sents}
    if not claims:
        return _na(r, "The Introduction states no key claim.")
    picks = await asyncio.gather(*[_support_for(c, sents, llm) for c in claims])
    sv: dict[int, list] = {c: ([p] if p is not None else []) for c, p in zip(claims, picks)}
    shallow = 0
    edges = []
    for c in claims:
        pi = _majority(sv.get(c, []), None)
        if pi is None:
            continue
        edges.append({"claim": c, "support": pi, "shallow": pi > c})
        if pi > c:
            shallow += 1
            r["instances"].append({
                "section": doc.intro_idx, "section_title": _sec_title(doc, doc.intro_idx), "sentence": c - 1,
                "text": sents[c - 1], "label": labels[c].replace("_", " "), "support_sentence": pi,
                "support_text": sents[pi - 1],
                "why": f"Its strongest support is sentence {pi}, which comes after the claim (sentence {c}).",
            })
    judged = len(edges)
    if judged == 0:
        return _na(r, "No claim received a supporting sentence.")
    r["num"], r["den"] = shallow, judged
    r["score"] = shallow / judged
    r["details"]["edges"] = edges
    r["notes"].append("LLM-judged approximation of the paper's PMI step: for each claim the model sees the other "
                      "Introduction sentences in shuffled order and picks the one the claim rests on, so position "
                      "cannot bias the choice. The paper scores this with log-probabilities, which the API does not return.")
    return r


# ============================================================================ Artifacts

def evidence_gap(doc: Document) -> dict:
    r = _base("evidence_gap")
    result_tables = [t for t in doc.tables if t.data_rows >= 2 and t.numeric_cells >= 4]
    r["details"] = {
        "result_tables": [{"label": t.label, "section_title": _sec_title(doc, t.home), "rows": t.data_rows,
                           "numeric_cells": t.numeric_cells, "caption": t.caption[:160]} for t in result_tables],
        "exhibits": [{"kind": e.kind, "where": e.where, "snippet": e.snippet} for e in doc.exhibits[:12]],
        "exhibit_count": len(doc.exhibits),
        "acknowledged": doc.gap_acknowledged,
    }
    if not result_tables:
        return _na(r, "The body holds no result table with two data rows and four numeric cells.")
    r["den"] = 1
    if doc.exhibits:
        r["score"], r["num"] = 0.0, 0
        return r
    if doc.gap_acknowledged:
        r["score"], r["num"] = 0.5, 0.5
        r["notes"].append("No exhibit, but the text acknowledges that no individual case was shown (scored 0.5).")
    else:
        r["score"], r["num"] = 1.0, 1
    first = result_tables[0]
    r["instances"].append({
        "section": first.home, "section_title": _sec_title(doc, first.home),
        "text": f"{len(result_tables)} result table(s) report aggregate numbers, but no example input, output, "
                f"case, or failure appears anywhere in the paper or its appendix.",
    })
    return r


FIG_KINDS = ["notation_key", "comparison_arm", "experimental_content", "evaluative_mark", "thesis_box",
             "enumerated_stage"]
FIG_KIND_NAMES = {"notation_key": "Notation key", "comparison_arm": "Comparison arm",
                  "experimental_content": "Experimental content", "evaluative_mark": "Evaluative mark",
                  "thesis_box": "Thesis box", "enumerated_stage": "Enumerated stages"}
_FIG_SCHEMA = {
    "type": "object",
    "properties": {
        "is_method_diagram": {"type": "boolean"},
        "elements": {"type": "array", "items": {
            "type": "object",
            "properties": {"text": {"type": "string"},
                           "role": {"type": "string", "enum": ["component", "connection"] + FIG_KINDS + ["other"]}},
            "required": ["text", "role"], "additionalProperties": False}},
    },
    "required": ["is_method_diagram", "elements"], "additionalProperties": False,
}
_FIG_PROMPT = """This image is the method figure of a scientific paper. Caption: "{caption}"

Transcribe every piece of text in the figure (box labels, arrow labels, titles, legend entries, annotations, numbers, and symbols such as ✓ or ✗), one element per distinct text item, and give each element exactly one role:
- component: names a module, input, output, data object, or process of the method.
- connection: labels an arrow or a data flow between components.
- notation_key: a legend or key explaining what a color, shape, icon, or symbol means.
- comparison_arm: shows or labels a baseline, a prior method, or an alternative path drawn for contrast ("Baseline", "Existing methods", "w/o X", "vs.").
- experimental_content: a setting of one experimental run rather than a constant of the method: dataset or benchmark names, hyperparameter values, model names used in experiments, numeric results or scores.
- evaluative_mark: a mark that judges quality: ✓ or ✗, "better", "worse", "fast", "accurate", praise words, up or down arrows next to a metric.
- thesis_box: a full sentence (with a verb) that states a claim, motivation, takeaway, or conclusion rather than naming a part of the method. Short titles and panel headings are "other".
- enumerated_stage: numbered narration of the pipeline such as "Stage 1", "Step 2", "(1)", "①", "Phase A".
- other: figure titles, axis labels, or anything else.

Set is_method_diagram to false only if the image does not depict how a method works (for example, a results plot)."""

_RX_STAGE = re.compile(r"^\s*(\(?\d+\)|[①-⑳]|(stage|step|phase|round)\s*[0-9IVX]+\b)", re.I)
_RX_KEY = re.compile(r"\blegend\b|\bdenotes?\b|^\s*\S+\s*(box|arrow|line|icon|node|color|colour)\s*[=:]", re.I)
_RX_EVAL = re.compile(r"[✓✔✗✘❌✅👍👎]")

METHOD_GATE = re.compile(r"\b(overview|pipeline|framework|architecture|workflow|schematic)\b", re.I)
METHOD_WEAK = re.compile(r"\b(our (method|approach|system|model|framework)|proposed|illustration of|method|approach)\b",
                         re.I)


def method_figure_candidates(doc: Document) -> list[dict]:
    out = []
    for k, f in enumerate(doc.figures):
        if not (f.images or f.pdf_clip):
            continue
        score = 2 * bool(METHOD_GATE.search(f.caption)) + bool(METHOD_WEAK.search(f.caption))
        out.append({"index": k, "label": f.label, "number": f.number, "caption": f.caption[:220],
                    "section_title": _sec_title(doc, f.home), "gate": score})
    return out


def render_figure(doc: Document, fig_index: int, out_dir: str) -> list[tuple[bytes, str, str]]:
    """Rasterize a figure to PNG. Returns [(png bytes, mime, saved relative filename)]."""
    import glob

    import pymupdf
    os.makedirs(out_dir, exist_ok=True)
    done = sorted(glob.glob(os.path.join(out_dir, f"figure_{fig_index}_*.png")))
    if done:   # rendered earlier (figures are pre-rendered so uploads can be deleted after analysis)
        return [(open(p_, "rb").read(), "image/png", os.path.basename(p_)) for p_ in done]
    f = doc.figures[fig_index]
    imgs = []
    if f.pdf_clip:
        path, page_no, x0, y0, x1, y1 = f.pdf_clip
        with pymupdf.open(path) as pdf:
            page = pdf[page_no]
            rect = pymupdf.Rect(x0, y0, x1, y1)
            zoom = min(3.0, 1600 / max(rect.width, 1))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=rect)
            imgs.append(pix.tobytes("png"))
    for p in f.images[:4]:
        ext = os.path.splitext(p)[1].lower()
        try:
            if ext == ".pdf":
                with pymupdf.open(p) as pdf:
                    page = pdf[0]
                    zoom = min(3.0, 1600 / max(page.rect.width, 1))
                    imgs.append(page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False).tobytes("png"))
            else:
                pix = pymupdf.Pixmap(p)
                if pix.alpha:
                    pix = pymupdf.Pixmap(pix, 0)
                if pix.width > 1800:
                    pix.shrink(1)
                imgs.append(pix.tobytes("png"))
        except Exception:
            continue
    out = []
    for k, b in enumerate(imgs):
        name = f"figure_{fig_index}_{k}.png"
        with open(os.path.join(out_dir, name), "wb") as fh:
            fh.write(b)
        out.append((b, "image/png", name))
    return out


async def figure_exposition(doc: Document, llm: LLM, out_dir: str, fig_index: Optional[int] = None,
                            runs: int = 3) -> dict:
    r = _base("figure_exposition")
    cands = method_figure_candidates(doc)
    r["details"]["candidates"] = cands
    if fig_index is None:
        gated = [c for c in cands if c["gate"] >= 2] or [c for c in cands if c["gate"] >= 1]
        if not gated:
            return _na(r, "No method figure passes the caption gate (overview / pipeline / framework / architecture).")
        fig_index = gated[0]["index"]
    if fig_index >= len(doc.figures):
        return _na(r, "Figure not found.")
    f = doc.figures[fig_index]
    r["details"].update({"figure": {"index": fig_index, "label": f.label, "number": f.number,
                                    "caption": f.caption[:300], "section_title": _sec_title(doc, f.home)}})
    images = render_figure(doc, fig_index, out_dir)
    if not images:
        return _na(r, "The method figure's image could not be read.")
    r["details"]["figure"]["images"] = [n for _, _, n in images]
    if not llm.available:
        r["status"] = "skipped"
        r["notes"].append("Needs a vision language model: set LITELLM_PROXY_API_KEY (or OPENROUTER_API_KEY).")
        return r
    content = [{"type": "text", "text": _FIG_PROMPT.format(caption=f.caption[:600].replace('"', "'"))}]
    content += [LLM.image_part(b, mime) for b, mime, _ in images[:4]]
    msgs = [{"role": "user", "content": content}]
    outs = await asyncio.gather(*[llm.json(msgs, _FIG_SCHEMA, "figure_transcript", run=k, max_tokens=12000)
                                  for k in range(runs)])
    present_votes: Counter = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    transcript = []
    not_method = 0
    for k, o in enumerate(outs):
        if not o.get("is_method_diagram", True):
            not_method += 1
        kinds_here = set()
        for el in o.get("elements", []):
            t, role = str(el.get("text", "")).strip(), el.get("role")
            if not t:
                continue
            if k == 0:
                transcript.append({"text": t, "role": role})
            # frozen patterns on the transcript for the patternable kinds
            if _RX_STAGE.search(t):
                role_rx = "enumerated_stage"
            elif _RX_KEY.search(t):
                role_rx = "notation_key"
            elif _RX_EVAL.search(t):
                role_rx = "evaluative_mark"
            else:
                role_rx = None
            for rr in {role, role_rx} - {None}:
                if rr in FIG_KINDS:
                    kinds_here.add(rr)
                    if t not in examples[rr]:
                        examples[rr].append(t)
        for kk in kinds_here:
            present_votes[kk] += 1
    present = [kk for kk in FIG_KINDS if present_votes[kk] * 2 > runs]
    r["num"], r["den"] = len(present), len(FIG_KINDS)
    r["score"] = len(present) / len(FIG_KINDS)
    for kk in present:
        r["instances"].append({"section": f.home, "section_title": _sec_title(doc, f.home), "kind": kk,
                               "label": FIG_KIND_NAMES[kk], "examples": examples[kk][:6],
                               "text": f"{FIG_KIND_NAMES[kk]}: " + " · ".join(f"“{e}”" for e in examples[kk][:4])})
    r["details"]["kinds"] = [{"kind": kk, "label": FIG_KIND_NAMES[kk], "present": kk in present,
                              "votes": present_votes[kk], "examples": examples[kk][:6]} for kk in FIG_KINDS]
    r["details"]["transcript"] = transcript[:80]
    if not_method * 2 > runs:
        r["notes"].append("The model doubts this figure depicts a method; choose another figure if one exists.")
    return r


# ============================================================================ aggregate

def aggregate(measures: dict[str, dict]) -> dict:
    planes = {}
    plane_scores = []
    for plane, keys in PLANES.items():
        vals = [measures[k]["score"] for k in keys if k in measures and measures[k]["status"] == "done"
                and measures[k]["score"] is not None]
        ps = sum(vals) / len(vals) if vals else None
        planes[plane] = {"score": ps, "items": len(vals)}
        if ps is not None:
            plane_scores.append(ps)
    S = sum(plane_scores) / len(plane_scores) if plane_scores else None
    pending = [k for k in META if measures.get(k, {}).get("status") in ("skipped", "error")]
    return {"score": S, "index": None if S is None else round(100 * S), "planes": planes,
            "partial": bool(pending), "missing": pending}
