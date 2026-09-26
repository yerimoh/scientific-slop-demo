"""Put the findings back on the paper: locate every flagged unit in a PDF of the paper, write the
highlighted PDF (with a summary cover page) and a first-page thumbnail for the gallery.

Sentences are located by matching their words against the PDF's own word list, so a sentence read
from LaTeX source still lands on the right lines of the typeset PDF. Captions, headings and figure
regions come from the PDF reader's recorded coordinates.
"""
from __future__ import annotations

import html
import re
from collections import Counter, defaultdict
from typing import Optional

import pymupdf

from .document import Document

# paper palette (Table 1 of the paper): mauve / rose / slate
PLANE_HEX = {"structure": "#95627A", "argument": "#E4959E", "artifacts": "#6D8A96"}
PLANE_RGB = {k: tuple(int(v[i:i + 2], 16) / 255 for i in (1, 3, 5)) for k, v in PLANE_HEX.items()}
_LIG = str.maketrans({"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "ft", "ﬆ": "st"})
_WORD_FLAGS = pymupdf.TEXT_DEHYPHENATE | pymupdf.TEXT_MEDIABOX_CLIP


def _norm_token(w: str) -> str:
    return re.sub(r"[^a-z0-9]", "", w.translate(_LIG).lower())


class PdfIndex:
    """Normalized word sequence with boxes for every page."""

    def __init__(self, path: str):
        self.path = path
        self.pdf = pymupdf.open(path)
        self.words: list[list[tuple]] = []      # per page: (x0, y0, x1, y1, token, block, line)
        self.first: list[dict] = []             # per page: token -> positions
        for page in self.pdf:
            ws = []
            for x0, y0, x1, y1, w, b, ln, _ in page.get_text("words", flags=_WORD_FLAGS):
                t = _norm_token(w)
                if t:
                    ws.append((x0, y0, x1, y1, t, b, ln))
            self.words.append(ws)
            d = defaultdict(list)
            for i, w in enumerate(ws):
                d[w[4]].append(i)
            self.first.append(d)

    @property
    def n_pages(self) -> int:
        return len(self.pdf)

    def sizes(self) -> list[list[float]]:
        return [[round(p.rect.width, 2), round(p.rect.height, 2)] for p in self.pdf]

    def find(self, toks: list[str]) -> list[tuple[int, int]]:
        """All (page, start index) where the token run occurs."""
        out = []
        k = len(toks)
        for p, ws in enumerate(self.words):
            for i in self.first[p].get(toks[0], ()):
                if i + k <= len(ws) and all(ws[i + j][4] == toks[j] for j in range(k)):
                    out.append((p, i))
        return out

    def rects(self, p: int, a: int, b: int) -> list[list[float]]:
        """Line-merged boxes covering words a..b (inclusive) of page p."""
        ws = self.words[p][a:b + 1]
        lines: dict[tuple, list] = {}
        order = []
        for x0, y0, x1, y1, _, blk, ln in ws:
            key = (blk, ln)
            if key not in lines:
                lines[key] = [x0, y0, x1, y1]
                order.append(key)
            else:
                r = lines[key]
                r[0], r[1], r[2], r[3] = min(r[0], x0), min(r[1], y0), max(r[2], x1), max(r[3], y1)
        return [[round(v, 1) for v in lines[k]] for k in order]


def locate_sentence(idx: PdfIndex, text: str) -> list[dict]:
    """[{p, r: [[x0, y0, x1, y1], ...]}] covering the sentence, or [] when it cannot be found."""
    segs = re.split(r"\[(?:cite|math|ref)\]", text)
    chunks: list[tuple[int, list[str]]] = []    # (token offset in the sentence, tokens)
    off = 0
    for seg in segs:
        toks = [t for t in (_norm_token(w) for w in seg.split()) if t]
        if len(toks) >= 3:
            size = 5 if len(toks) >= 5 else len(toks)
            for i in range(0, max(1, len(toks) - size + 1), 3):
                chunks.append((off + i, toks[i:i + size]))
            if len(toks) > size and (len(toks) - size) % 3:
                chunks.append((off + len(toks) - size, toks[-size:]))
        off += len(toks) + 1
    if not chunks:
        return []
    hits = [(o, c, idx.find(c)) for o, c in chunks]
    votes = Counter()
    for _, _, hs in hits:
        for p, _ in set(hs):
            votes[p] += 1
    if not votes:
        return []
    best = votes.most_common(1)[0][0]
    total = off
    spans: dict[int, list[int]] = defaultdict(list)
    anchor = None
    for o, c, hs in hits:
        cand = [(p, i) for p, i in hs if p in (best, best + 1)]
        if not cand:
            continue
        if anchor is None:
            p, i = cand[0]
        else:
            # the occurrence closest to where the sentence already sits
            ap, ai, ao = anchor
            p, i = min(cand, key=lambda x: (abs((x[1] - ai) - (o - ao)) if x[0] == ap else 10 ** 6 + x[1]))
        anchor = (p, i, o)
        spans[p] += [i, i + len(c) - 1]
    out = []
    for p in sorted(spans):
        a, b = min(spans[p]), max(spans[p])
        if b - a > 3 * total + 20:      # matches too far apart to be one sentence
            continue
        out.append({"p": p, "r": idx.rects(p, a, b)})
    return out


def _obj_loc(pdf_doc: Document, kind: str, number: Optional[str], title: str = "") -> Optional[tuple]:
    for o in pdf_doc.objects:
        if o.kind == kind and o.loc and number and o.number == number:
            return o.loc
    if kind == "section" and title:
        t = _norm_token(title)
        for o in pdf_doc.objects:
            if o.kind == "section" and o.loc and _norm_token(re.sub(r"^§\S*\s*", "", o.display)) == t:
                return o.loc
    return None


def _box(loc: tuple) -> list[dict]:
    p, x0, y0, x1, y1 = loc
    return [{"p": p, "r": [[round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]]}]


def locate_findings(result: dict, doc: Document, view_pdf: str, pdf_doc: Optional[Document] = None) -> dict:
    """Attach `pdf` locations to every instance of `result`; returns the pdf summary block."""
    idx = PdfIndex(view_pdf)
    if pdf_doc is None:
        from .pdf import read_pdf
        try:
            pdf_doc = read_pdf(view_pdf)
        except Exception:
            pdf_doc = Document(source="pdf")
    objs = {o.id: o for o in doc.objects}
    found = total = 0
    for m in result["measures"]:
        key = m["key"]
        for inst in m.get("instances", []):
            locs: list[dict] = []
            if key in ("macro_redundancy", "citation_isolation", "argument_graph"):
                locs = locate_sentence(idx, inst.get("text", ""))
            elif key == "cross_refs":
                o = objs.get(inst.get("id"))
                if o is not None:
                    if o.loc:
                        locs = _box(o.loc)
                    else:
                        title = re.sub(r"^§\S*\s*", "", o.display or "")
                        loc = _obj_loc(pdf_doc, o.kind, o.number, title)
                        if loc:
                            locs = _box(loc)
                        elif o.caption:
                            locs = locate_sentence(idx, " ".join(o.caption.split()[:12]))
            elif key == "figure_exposition":
                fig = (m.get("details") or {}).get("figure") or {}
                clip = None
                if doc.source == "pdf" and fig.get("index") is not None and fig["index"] < len(doc.figures):
                    clip = doc.figures[fig["index"]].pdf_clip
                if clip is None and fig.get("number"):
                    for f in pdf_doc.figures:
                        if f.number == fig["number"] and f.pdf_clip:
                            clip = f.pdf_clip
                            break
                if clip:
                    _, p, x0, y0, x1, y1 = clip
                    locs = [{"p": p, "r": [[round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]], "box": True}]
            elif key == "evidence_gap":
                tabs = (m.get("details") or {}).get("result_tables") or []
                for t in tabs[:1]:
                    num = None
                    mm = re.match(r"Table\s+(\S+)", t.get("label", ""))
                    if mm:
                        num = mm.group(1)
                    else:
                        o = next((x for x in doc.objects if t.get("label") in x.aliases), None)
                        num = o.number if o else None
                    loc = _obj_loc(pdf_doc, "table", num)
                    if loc:
                        locs = _box(loc)
            total += 1
            if locs:
                found += 1
                inst["pdf"] = locs
    return {"available": True, "pages": idx.n_pages, "sizes": idx.sizes(), "located": found, "findings": total}


# ----------------------------------------------------------------------------- outputs

def _note(m: dict, inst: dict) -> str:
    extra = {
        "macro_redundancy": lambda i: f"{round(100 * i.get('coverage', 0))}% repeats {i.get('source_title', 'an earlier section')}.",
        "citation_isolation": lambda i: i.get("why", ""),
        "argument_graph": lambda i: i.get("why", ""),
        "cross_refs": lambda i: i.get("text", ""),
        "figure_exposition": lambda i: i.get("text", ""),
        "evidence_gap": lambda i: i.get("text", ""),
    }.get(m["key"], lambda i: "")(inst)
    return f"{m['name']} ({m['plane'].title()}). {extra}".strip()


def _cover_html(result: dict) -> str:
    idx = result["index"]
    doc = result["document"]
    rows = []
    for m in result["measures"]:
        sc = "—" if m.get("score") is None else f"{round(100 * m['score'])}"
        frac = f"{m.get('num', 0):g} / {m.get('den', 0)} {m.get('unit', '')}" if m.get("status") == "done" else m.get("status", "")
        rows.append(
            f"<tr><td><span style='color:{PLANE_HEX[m['plane']]}'>&#9632;</span> {html.escape(m['name'])}</td>"
            f"<td style='text-align:right'><b>{sc}</b></td><td>{html.escape(frac)}</td>"
            f"<td>{len(m.get('instances', []))}</td></tr>")
    planes = " &nbsp;·&nbsp; ".join(
        f"<span style='color:{PLANE_HEX[k]}'><b>{k.upper()}</b></span> {'—' if v['score'] is None else round(100 * v['score'])}"
        for k, v in idx["planes"].items())
    return f"""
<div style="font-family: sans-serif; color:#1F2937">
<p style="font-size:9pt; letter-spacing:1px; color:#6B7280">SCIENCE SLOP INDEX · REPORT</p>
<h1 style="font-size:17pt; margin:4pt 0 14pt 0">{html.escape(doc.get('title', ''))}</h1>
<p style="font-size:40pt; margin:0"><b>{idx.get('index') if idx.get('index') is not None else '—'}</b><span style="font-size:14pt; color:#6B7280"> / 100</span></p>
<p style="font-size:10pt; color:#374151">Averaged over three planes, this share of measured units shows a slop pattern{' (partial: some measures could not run)' if idx.get('partial') else ''}.</p>
<p style="font-size:10pt">{planes}</p>
<style>td {{ padding: 2pt 8pt 2pt 0; }}</style>
<table style="font-size:9.5pt; width:100%; border-collapse:collapse; margin-top:10pt">
<tr style="color:#6B7280"><td>Measure</td><td style="text-align:right">Score</td><td>Units</td><td>Flagged</td></tr>
{''.join(rows)}
</table>
<p style="font-size:9pt; color:#374151; margin-top:14pt">Highlights in the following pages mark every flagged unit,
colored by plane: <span style="color:{PLANE_HEX['structure']}"><b>Structure</b></span>,
<span style="color:{PLANE_HEX['argument']}"><b>Argument</b></span>,
<span style="color:{PLANE_HEX['artifacts']}"><b>Artifacts</b></span>. Open a highlight's note for the reason.</p>
<p style="font-size:8pt; color:#6B7280; margin-top:10pt">The index describes a paper's text, not its authors.
Bands are descriptive, not a probability of AI authorship. scislop.open-galapagos.com</p>
</div>"""


def annotated_pdf(view_pdf: str, result: dict, cover: bool = True) -> bytes:
    pdf = pymupdf.open(view_pdf)
    for m in result["measures"]:
        rgb = PLANE_RGB.get(m.get("plane"), (1, 0.8, 0))
        for inst in m.get("instances", []):
            for loc in inst.get("pdf", []):
                if loc["p"] >= len(pdf):
                    continue
                page = pdf[loc["p"]]
                rects = [pymupdf.Rect(*r) for r in loc["r"]]
                if loc.get("box"):
                    a = page.add_rect_annot(rects[0])
                    a.set_border(width=1.6)
                    a.set_colors(stroke=rgb)
                else:
                    a = page.add_highlight_annot(rects)
                    a.set_colors(stroke=rgb)
                    a.set_opacity(0.55)
                a.set_info(title="Science Slop Index", content=_note(m, inst))
                a.update()
    if cover:
        w, h = pdf[0].rect.width, pdf[0].rect.height
        page = pdf.new_page(0, width=w, height=h)
        try:
            page.insert_htmlbox(pymupdf.Rect(54, 54, w - 54, h - 54), _cover_html(result))
        except Exception:
            page.insert_text((54, 80), f"Science Slop Index: {result['index'].get('index')} / 100", fontsize=16)
    return pdf.tobytes(garbage=3, deflate=True)


def thumbnail(view_pdf: str, width: int = 520) -> bytes:
    with pymupdf.open(view_pdf) as pdf:
        page = pdf[0]
        z = width / page.rect.width
        return page.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False).tobytes("png")


def page_image(view_pdf: str, n: int, width: int = 1100) -> bytes:
    with pymupdf.open(view_pdf) as pdf:
        page = pdf[n]
        z = width / page.rect.width
        return page.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False).tobytes("jpeg", jpg_quality=82)
