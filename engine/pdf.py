"""PDF reader: rebuilds the structure view from layout (Appendix A: "we reconstruct the same LaTeX
structure from the PDF, recovering headings, float labels, citations, and references").

Recovered from the PDF: section headings (numbered or named), figure / table / algorithm captions and
numbered equations as objects, printed pointers ("Table 2", "Sec. 3.1", "Eq. (4)", "Appendix B"),
numeric and author-year citations, result tables, exhibits, and the method figure's page region.
It never invents content that is absent from the PDF.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Optional

import pymupdf

from .document import Document, Exhibit, Figure, Obj, Pointer, Section, Sentence, Table
from .latex import ACK_GAP, EXHIBIT_CAPTION, _RELATED, _INTRO, _STATEMENT, _IO_MARKER
from .text import CITE_MARK, split_sentences


@dataclass
class Line:
    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    size: float
    bold: bool
    mono: bool
    block: int
    col: int = 0
    kind: str = "text"        # text | heading | caption | small | noise | table
    meta: dict = field(default_factory=dict)


_HEAD_NUM = re.compile(r"^(?P<num>(?:\d{1,2}|[A-H])(?:\.\d{1,2}){0,3})\.?\s+(?P<title>[A-Z][^\n]{1,90})$")
_HEAD_NAMED = re.compile(
    r"^(abstract|introduction|related work|related works|background|preliminaries|method|methods|methodology|approach|"
    r"experiments?|experimental setup|results|evaluation|analysis|discussion|conclusions?|limitations|"
    r"broader impacts?|references|bibliography|acknowledg(e)?ments?|appendix|appendices|supplementary material|"
    r"ethics statement|reproducibility statement|impact statement|conclusion and future work|"
    r"related work and background|background and related work|summary)\s*$", re.I)
_CAPTION = re.compile(r"^(?P<kind>Figure|Fig\.|Table|Tab\.|Algorithm|Alg\.)\s*(?P<num>[A-Z]?\d{1,3})\s*[:.|]\s*", re.I)
_EQNUM = re.compile(r"^\((\d{1,3})\)$")
_NOISE_NUM = re.compile(r"^\d{1,4}$")
_BACK_START = re.compile(r"^(references|bibliography|acknowledg(e)?ments?|appendix|appendices|supplementary material)\b", re.I)


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", t.replace("­", "")).strip()


def _extract_lines(pdf) -> tuple[list[Line], float, dict]:
    lines: list[Line] = []
    sizes = Counter()
    for pno, page in enumerate(pdf):
        d = page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_DEHYPHENATE)
        for bno, b in enumerate(d["blocks"]):
            if b.get("type") != 0:
                continue
            for ln in b["lines"]:
                spans = [s for s in ln["spans"] if s["text"].strip()]
                if not spans:
                    continue
                text = _norm("".join(s["text"] for s in ln["spans"]))
                if not text:
                    continue
                # dominant span by characters
                dom = max(spans, key=lambda s: len(s["text"].strip()))
                size = round(dom["size"] * 2) / 2
                bold = bool(dom["flags"] & 16) or "Bold" in dom["font"] or "bold" in dom["font"] or ".B" in dom["font"]
                mono = bool(dom["flags"] & 8) or bool(re.search(r"mono|courier|cmtt|typewriter|consol|menlo|inconsolata|sfmono",
                                                                 dom["font"], re.I))
                x0, y0, x1, y1 = ln["bbox"]
                lines.append(Line(pno, x0, y0, x1, y1, text, size, bold, mono, bno))
                sizes[size] += len(text)
    body_size = sizes.most_common(1)[0][0] if sizes else 10.0
    # merge fragments of one visual line (a heading number and its title often come as two lines)
    merged: list[Line] = []
    for l in lines:
        m = merged[-1] if merged else None
        if m and m.page == l.page and m.block == l.block and abs(m.y0 - l.y0) < 2.0 and l.x0 >= m.x1 - 1 \
                and l.x0 - m.x1 < 40:
            m.text = _norm(m.text + " " + l.text)
            m.x1 = max(m.x1, l.x1)
            m.bold = m.bold or l.bold
            m.size = max(m.size, l.size) if len(l.text) > len(m.text) / 2 else m.size
            continue
        merged.append(l)
    info = {"pages": len(pdf), "body_size": body_size}
    return merged, body_size, info


def _mark_noise(lines: list[Line], pdf, body_size: float):
    """Margin line numbers, running headers and footers, page numbers."""
    body = [l for l in lines if abs(l.size - body_size) <= 0.6 and len(l.text) > 30]
    if not body:
        return
    left = sorted(l.x0 for l in body)[len(body) // 50] if len(body) > 50 else min(l.x0 for l in body)
    right = sorted(l.x1 for l in body)[-(len(body) // 50) - 1] if len(body) > 50 else max(l.x1 for l in body)
    heights = {p: pdf[p].rect.height for p in range(len(pdf))}
    rep = Counter()
    for l in lines:
        h = heights[l.page]
        if l.y0 < 0.07 * h or l.y1 > 0.93 * h:
            rep[re.sub(r"\d+", "#", l.text.lower())] += 1
    npages = len(pdf)
    for l in lines:
        h = heights[l.page]
        if _NOISE_NUM.match(l.text) and (l.x1 < left + 2 or l.x0 > right - 2):
            l.kind = "noise"      # review line numbers in the margins
        elif (l.y0 < 0.07 * h or l.y1 > 0.93 * h) and (
                _NOISE_NUM.match(l.text) or rep[re.sub(r"\d+", "#", l.text.lower())] >= max(3, npages * 0.3)):
            l.kind = "noise"      # running header / footer / page number
        elif re.match(r"^(under review|published) as a conference paper", l.text, re.I):
            l.kind = "noise"
        elif re.match(r"^arXiv:\d{4}\.\d{4,5}", l.text):
            l.kind = "noise"


def _order(lines: list[Line], pdf) -> list[Line]:
    """Reading order with two-column detection per page."""
    out = []
    by_page = defaultdict(list)
    for l in lines:
        by_page[l.page].append(l)
    for p in sorted(by_page):
        pl = by_page[p]
        w = pdf[p].rect.width
        mid = w / 2
        left = [l for l in pl if l.x1 <= mid + 12 and l.kind != "noise"]
        right = [l for l in pl if l.x0 >= mid - 12 and l.kind != "noise"]
        two_col = len([l for l in left if len(l.text) > 25]) >= 8 and len([l for l in right if len(l.text) > 25]) >= 8
        if not two_col:
            pl.sort(key=lambda l: (round(l.y0, 0), l.x0))
            out += pl
            continue
        for l in pl:
            l.col = 0 if l.x1 <= mid + 12 else (1 if l.x0 >= mid - 12 else -1)
        fulls = sorted([l for l in pl if l.col == -1], key=lambda l: l.y0)
        # bands separated by full-width lines
        cuts = [0.0] + [l.y0 for l in fulls] + [1e9]
        seen = set()
        for i in range(len(cuts) - 1):
            a, b = cuts[i], cuts[i + 1]
            band_full = [l for l in fulls if l.y0 == a and id(l) not in seen]
            for l in band_full:
                seen.add(id(l))
                out.append(l)
            for c in (0, 1):
                seg = sorted([l for l in pl if l.col == c and a <= l.y0 < b], key=lambda l: (l.y0, l.x0))
                out += seg
    return out


def _split_citations(text: str, style: str) -> str:
    """Replace printed citations with ⟦c:keys⟧ markers."""
    if style == "numeric":
        def rep(m):
            keys = []
            for part in re.split(r"\s*,\s*", m.group(1)):
                if re.match(r"^\d+\s*[-–]\s*\d+$", part):
                    a, b = [int(x) for x in re.split(r"\s*[-–]\s*", part)]
                    if 0 < b - a < 30:
                        keys += [f"ref{k}" for k in range(a, b + 1)]
                elif part.strip().isdigit():
                    keys.append(f"ref{int(part)}")
            return f" ⟦c:{','.join(keys)}⟧ " if keys else m.group(0)
        return re.sub(r"\[(\d{1,3}(?:\s*[-–,]\s*\d{1,3})*)\]", rep, text)

    # author-year: parenthetical groups, then textual "Name et al. (2020)"
    yr = r"(?:19|20)\d{2}[a-z]?"

    def key_of(piece: str) -> Optional[str]:
        m = re.search(r"([A-Z][A-Za-z\-'’À-ž]+)(?:\s+et al\.?|\s*(?:,|and|&)\s*[A-Z][A-Za-z\-'’À-ž]+)*[,\s]*\(?(" + yr + r")", piece)
        if not m:
            return None
        return (m.group(1) + m.group(2)).lower()

    def rep_paren(m):
        inner = m.group(1)
        if not re.search(yr, inner) or not re.search(r"[A-Z][a-z]", inner):
            return m.group(0)
        keys = [k for k in (key_of(p) for p in re.split(r";", inner)) if k]
        return f" ⟦c:{','.join(keys)}⟧ " if keys else m.group(0)

    text = re.sub(r"\(((?:[^()]|\([^()]*\))*?" + yr + r"[^()]*)\)", rep_paren, text)

    def rep_text(m):
        k = (m.group(1) + m.group(3)).lower()
        return f"{m.group(0).split('(')[0].strip()} ⟦c:{k}⟧"
    text = re.sub(r"\b([A-Z][A-Za-z\-'’]+)((?:\s+et al\.?)|(?:\s+(?:and|&)\s+[A-Z][A-Za-z\-'’]+))?\s*\((" + yr + r")\)",
                  rep_text, text)
    return text


def _cite_style(text: str) -> str:
    num = len(re.findall(r"\[\d{1,3}(?:\s*[-–,]\s*\d{1,3})*\]", text))
    ay = len(re.findall(r"(?:et al\.?,?\s*\(?(?:19|20)\d{2}|\((?:[A-Z][A-Za-z\-]+[^()]{0,40}?,\s*(?:19|20)\d{2}))", text))
    return "numeric" if num > ay else "author-year"


def _join(lines: list[Line]) -> str:
    """Join lines into paragraphs; a vertical gap or an indent starts a new paragraph."""
    out = []
    prev = None
    for l in lines:
        t = l.text
        if prev is not None:
            gap = l.y0 - prev.y1
            new_para = (l.page != prev.page and False) or gap > 0.9 * (prev.y1 - prev.y0) or \
                (l.x0 - prev.x0 > 8 and l.col == prev.col and l.page == prev.page and gap >= 0)
            if new_para and prev.text.rstrip().endswith((".", ":", "?", "!")):
                out.append("\n\n")
            elif out and out[-1].endswith("-") and t[:1].islower():
                out[-1] = out[-1][:-1]
            else:
                out.append(" ")
        out.append(t)
        prev = l
    return "".join(out)


def _sentences(text: str, style: str) -> list[Sentence]:
    text = _split_citations(text, style)
    out = []
    for s in split_sentences(text):
        groups = [[k for k in m.group(1).split(",") if k] for m in CITE_MARK.finditer(s)]
        t = CITE_MARK.sub("[cite]", s)
        t = re.sub(r"\s+", " ", t).strip()
        t = re.sub(r"\s+([,.;:])", r"\1", t)
        if len(re.sub(r"\[(cite|math|ref)\]", "", t).strip(" .,;:")) < 2:
            continue
        out.append(Sentence(text=t, cites=groups))
    return out


def _is_heading(l: Line, body_size: float) -> Optional[tuple[str, str, int]]:
    t = l.text.strip()
    if len(t) > 95 or len(t) < 3 or t.endswith((",", ";")):
        return None
    bigger = l.size >= body_size + 0.4
    emph = l.bold or bigger or (t.isupper() and len(t) > 4)
    if not emph:
        return None
    m = _HEAD_NUM.match(t)
    if m:
        num, title = m.group("num"), m.group("title").strip()
        if re.match(r"^\d+(\.\d+)?$", title) or re.search(r"\d{3,}", title) and not re.search(r"[a-z]{3}", title):
            return None
        if len(title.split()) > 14:
            return None
        return num, title, num.count(".") + 1
    if _HEAD_NAMED.match(t):
        return "", t, 1
    return None


def _title_case(t: str) -> str:
    return t.title() if t.isupper() else t


def read_pdf(path: str) -> Document:
    pdf = pymupdf.open(path)
    lines, body_size, info = _extract_lines(pdf)
    if sum(len(l.text) for l in lines) < 2000:
        raise ValueError("This PDF has almost no extractable text (it may be scanned); OCR is not supported.")
    _mark_noise(lines, pdf, body_size)
    lines = [l for l in _order(lines, pdf) if l.kind != "noise"]
    doc = Document(source="pdf", workdir=None)

    # title: largest text on page 1 above the abstract
    p0 = [l for l in lines if l.page == 0 and l.y0 < pdf[0].rect.height * 0.45 and len(l.text) >= 4
          and len(re.findall(r"[A-Za-z]{2,}", l.text)) >= 1]
    if p0:
        big = max(l.size for l in p0 if len(l.text.split()) >= 2) if any(len(l.text.split()) >= 2 for l in p0) \
            else max(l.size for l in p0)
        tl = [l for l in p0 if l.size >= big - 0.5]
        if tl:
            first = min(tl, key=lambda l: l.y0)
            tl = [l for l in tl if l.y0 - first.y0 < 4 * (first.y1 - first.y0) + 6]
        doc.title = _norm(" ".join(l.text for l in tl))[:300]

    # headings
    heads = []
    for i, l in enumerate(lines):
        hd = _is_heading(l, body_size)
        if hd:
            heads.append((i, hd))
    numbered = sum(1 for _, (n, t, lv) in heads if n and n[0].isdigit() and lv == 1)
    if numbered >= 3:
        heads = [(i, hd) for i, hd in heads if hd[0] or _BACK_START.match(hd[1]) or hd[1].lower().startswith("abstract")]
    for i, hd in heads:
        lines[i].kind = "heading"
    # captions
    for l in lines:
        if l.kind == "text" and _CAPTION.match(l.text) and (l.x0 < pdf[l.page].rect.width * 0.62):
            l.kind = "caption"

    # abstract & body boundaries
    abs_i = next((i for i, (li, (n, t, lv)) in enumerate(heads) if t.lower().startswith("abstract")), None)
    top = [(li, hd) for li, hd in heads if hd[2] == 1]
    body_heads = []
    back_i = None
    started = False
    for li, (num, title, lv) in top:
        if _BACK_START.match(title):
            if started:
                back_i = li
                break
            continue
        if title.lower().startswith("abstract"):
            continue
        if not started:
            if num in ("1", "I") or _INTRO.search(title) or (num.isdigit()):
                started = True
            else:
                continue
        if num and not num[0].isdigit() and started:
            back_i = li            # lettered appendix heading
            break
        body_heads.append((li, num, title))
    if not body_heads:
        # no numbered headings: fall back to named top headings
        body_heads = [(li, n, t) for li, (n, t, lv) in top if not _BACK_START.match(t) and not t.lower().startswith("abstract")]
    if not body_heads:
        raise ValueError("Could not find the section headings of this PDF.")
    end_body = back_i if back_i is not None else len(lines)
    doc.warnings.append("Structure rebuilt from the PDF layout; cross-references are read from printed mentions.")

    # citation style
    all_text = " ".join(l.text for l in lines[:end_body])
    style = _cite_style(all_text)
    doc.stats["citation_style"] = style

    # abstract
    if abs_i is not None:
        a0 = heads[abs_i][0] + 1
        a1 = body_heads[0][0]
        ab = [l for l in lines[a0:a1] if l.kind == "text" and abs(l.size - body_size) <= 1.2]
        doc.abstract = Section(idx=0, title="Abstract", number=None, kind="abstract",
                               sentences=_sentences(_join(ab), style))
    else:
        first = body_heads[0][0]
        ab = [l for l in lines[:first] if l.page == 0 and l.kind == "text" and abs(l.size - body_size) <= 1.2
              and len(l.text) > 40]
        if ab:
            doc.abstract = Section(idx=0, title="Abstract", number=None, kind="abstract",
                                   sentences=_sentences(_join(ab), style))

    # sections
    sec_lines: dict[int, list[Line]] = {}
    sec_of_line: dict[int, int] = {}
    moved = []
    kept_heads = []
    for k, (li, num, title) in enumerate(body_heads):
        stop = body_heads[k + 1][0] if k + 1 < len(body_heads) else end_body
        if _STATEMENT.search(title):
            moved.append(title)
            continue
        kept_heads.append((li, stop, num, title))
    if moved:
        doc.warnings.append("Excluded statement sections from the body: " + ", ".join(moved))
    for idx, (li, stop, num, title) in enumerate(kept_heads, 1):
        sec = Section(idx=idx, title=_title_case(title), number=num or None)
        doc.sections.append(sec)
        span = lines[li + 1:stop]
        sec_lines[idx] = span
        for j in range(li, stop):
            sec_of_line[j] = idx
        hl = lines[li]
        doc.objects.append(Obj(id=f"§{idx}", kind="section", home=idx,
                               display=(f"§{num} " if num else "") + _title_case(title), number=num or None,
                               loc=(hl.page, hl.x0, hl.y0, hl.x1, hl.y1)))

    # captions -> objects, figures, tables
    cap_objs: dict[tuple[str, str], Obj] = {}
    caption_texts: list[tuple[int, str, str, str, int]] = []   # (home, kind, num, text, line index)
    for j, l in enumerate(lines[:end_body]):
        if l.kind != "caption" or j not in sec_of_line:
            continue
        m = _CAPTION.match(l.text)
        kind = {"f": "figure", "t": "table", "a": "algorithm"}[m.group("kind")[0].lower()]
        num = m.group("num")
        # caption continues on the following lines: same page and column, no paragraph gap
        cap = [l.text]
        cap_lines = [l]
        prev = l
        for l2 in lines[j + 1:j + 14]:
            gap = l2.y0 - prev.y1
            if (l2.page == l.page and l2.kind in ("text", "small") and -2 <= gap < 0.8 * (prev.y1 - prev.y0) + 1
                    and abs(l2.size - l.size) <= 0.6 and l2.x0 >= l.x0 - 12 and l2.x1 <= max(l.x1, prev.x1) + 40):
                cap.append(l2.text)
                cap_lines.append(l2)
                l2.kind = "caption_cont"
                prev = l2
                if l2.text.rstrip().endswith(".") and len(l2.text) < 0.6 * len(l.text):
                    break
            else:
                break
        text = re.sub(r"(\w)- (\w)", r"\1-\2", _norm(" ".join(cap)))
        home = sec_of_line[j]
        caption_texts.append((home, kind, num, text, j))
        key = (kind, num)
        if key in cap_objs:
            continue
        disp = {"figure": "Figure", "table": "Table", "algorithm": "Algorithm"}[kind] + f" {num}"
        o = Obj(id=f"{kind}:{num}", kind=kind, home=home, aliases=[f"{kind}:{num}"],
                caption=_CAPTION.sub("", text)[:300], number=num, display=disp,
                loc=(l.page, min(c.x0 for c in cap_lines), l.y0, max(c.x1 for c in cap_lines), cap_lines[-1].y1))
        cap_objs[key] = o
        doc.objects.append(o)
    # numbered equations
    eq_anchor: list[tuple[int, str]] = []
    for j, l in enumerate(lines[:end_body]):
        if j not in sec_of_line:
            continue
        m = _EQNUM.match(l.text)
        if m and l.x0 > pdf[l.page].rect.width * 0.35:
            key = ("equation", m.group(1))
            if key not in cap_objs:
                o = Obj(id=f"equation:{m.group(1)}", kind="equation", home=sec_of_line[j], number=m.group(1),
                        display=f"Eq. ({m.group(1)})", loc=(l.page, l.x0, l.y0, l.x1, l.y1))
                cap_objs[key] = o
                doc.objects.append(o)
            eq_anchor.append((j, cap_objs[key].id))
            l.kind = "noise"

    # prose: body-size text lines only (figure labels, tables and footnotes are set smaller or are captions)
    def is_prose(l: Line) -> bool:
        if l.kind != "text":
            return False
        if abs(l.size - body_size) > 0.75:
            return False
        return True

    def table_like(chunk: list[Line]) -> bool:
        nums = sum(len(re.findall(r"(?<![A-Za-z])\d+(?:\.\d+)?%?", l.text)) for l in chunk)
        words = sum(len(l.text.split()) for l in chunk)
        short = sum(1 for l in chunk if len(l.text.split()) <= 5)
        return len(chunk) >= 2 and short / len(chunk) > 0.7 and nums >= 0.25 * words

    for idx, span in sec_lines.items():
        # group by block to drop table-like blocks set at body size
        blocks = defaultdict(list)
        for l in span:
            blocks[(l.page, l.block)].append(l)
        keep = []
        for l in span:
            if not is_prose(l):
                continue
            if table_like(blocks[(l.page, l.block)]):
                l.kind = "table"
                continue
            keep.append(l)
        sec = doc.section(idx)
        sec.sentences = _sentences(_join(keep), style)

    # pointers from prose and captions
    by_num = {("section", s.number): f"§{s.idx}" for s in doc.sections if s.number}
    for s in doc.sections:
        if s.number:
            by_num.setdefault(("section", s.number.split(".")[0]), f"§{s.idx}")
    for (kind, num), o in cap_objs.items():
        by_num[(kind, num)] = o.id
    rx = [
        (re.compile(r"\b(?:Sections?|Secs?\.|§)\s*(\d+(?:\.\d+)*)((?:\s*(?:,|and|&|–|-)\s*\d+(?:\.\d+)*)*)"), "section"),
        (re.compile(r"\b(?:Figures?|Figs?\.)\s*(\d+)((?:\s*(?:,|and|&|–|-)\s*\d+)*)"), "figure"),
        (re.compile(r"\b(?:Tables?|Tabs?\.)\s*(\d+)((?:\s*(?:,|and|&|–|-)\s*\d+)*)"), "table"),
        (re.compile(r"\b(?:Algorithms?|Algs?\.)\s*(\d+)"), "algorithm"),
        (re.compile(r"\b(?:Equations?|Eqs?\.)\s*\(?(\d+)\)?((?:\s*(?:,|and|&|–|-)\s*\(?\d+\)?)*)"), "equation"),
    ]
    app_rx = re.compile(r"\b(?:Appendi(?:x|ces)|App\.)\s*([A-Z](?:\.\d+)*)\b")

    def scan(idx: int, text: str, own: Optional[str] = None):
        found = []
        for r_, kind in rx:
            for m in r_.finditer(text):
                nums = [m.group(1)]
                if m.lastindex and m.lastindex >= 2 and m.group(2):
                    nums += re.findall(r"\d+(?:\.\d+)*", m.group(2))
                for n in nums:
                    key = (kind, n if kind != "section" else n)
                    tgt = by_num.get(key) or (by_num.get(("section", n.split(".")[0])) if kind == "section" else None)
                    if tgt and tgt != own:
                        found.append((m.start(), tgt, m.group(0)))
        for m in app_rx.finditer(text):
            found.append((m.start(), "appendix:" + m.group(1), m.group(0)))
        found.sort()
        for pos, tgt, ctx in found:
            doc.pointers.append(Pointer(src=idx, target=tgt, via="number", pos=pos, context=ctx))

    for s in doc.sections:
        scan(s.idx, " ".join(x.text for x in s.sentences))
    for home, kind, num, text, j in caption_texts:
        scan(home, _CAPTION.sub("", text), own=f"{kind}:{num}")
    # hyperref link annotations: every \\ref / \\eqref of a LaTeX-made PDF, with its exact source position
    anchors = []
    for j2, l2 in enumerate(lines[:end_body]):
        if l2.kind == "heading" and j2 in sec_of_line:
            anchors.append(("section", j2, f"§{sec_of_line[j2]}"))
    for home, kind, num, text, j2 in caption_texts:
        anchors.append((kind, j2, f"{kind}:{num}"))
    for j2, oid in eq_anchor:
        anchors.append(("equation", j2, oid))
    n_links = _link_pointers(pdf, lines, sec_of_line, end_body, anchors, doc)
    doc.stats["link_pointers"] = n_links

    # named references to sections
    for s in doc.sections:
        t = s.title.strip()
        if len(t) < 6:
            continue
        for other in doc.sections:
            if other.idx == s.idx:
                continue
            body = " ".join(x.text for x in other.sentences)
            for m in re.finditer(r"\b(?:the\s+)?[“\"']?" + re.escape(t) + r"[”\"']?\s+section\b", body, re.I):
                doc.pointers.append(Pointer(src=other.idx, target=f"§{s.idx}", via="name", pos=m.start()))

    # tables for evidence gap
    for home, kind, num, text, j in caption_texts:
        if kind != "table":
            continue
        cap_line = lines[j]
        dr, nc = _table_numbers(pdf, lines, j, cap_line)
        doc.tables.append(Table(home=home, label=f"Table {num}", caption=_CAPTION.sub("", text)[:200],
                                data_rows=dr, numeric_cells=nc))

    # figures (method figure region)
    for home, kind, num, text, j in caption_texts:
        if kind != "figure":
            continue
        clip = _figure_region(pdf, lines, j, body_size)
        doc.figures.append(Figure(home=home, label=f"Figure {num}", caption=_CAPTION.sub("", text), number=num,
                                  pdf_clip=(path, *clip) if clip else None))

    # exhibits: body and appendix (bibliography excluded)
    back = lines[end_body:]
    ref_start = next((k for k, l in enumerate(back) if l.kind == "heading" and re.match(r"^(references|bibliography)", l.text, re.I)), None)
    appendix_lines = back
    if ref_start is not None:
        after = back[ref_start + 1:]
        app_k = next((k for k, l in enumerate(after) if l.kind == "heading" and (
            re.match(r"^[A-H](\.\d+)*\.?\s+[A-Z]", l.text) or re.match(r"^appendi", l.text, re.I))), None)
        appendix_lines = back[:ref_start] + (after[app_k:] if app_k is not None else [])
        refs = after[:app_k] if app_k is not None else after
        doc.work_names = _reference_names(refs, style)
    related = {s.idx for s in doc.sections if _RELATED.search(s.title)}
    for home, kind, num, text, j in caption_texts:
        if EXHIBIT_CAPTION.search(_CAPTION.sub("", text)):
            doc.exhibits.append(Exhibit(kind="caption", where=doc.section(home).title, snippet=text[:220]))
    for k, l in enumerate(appendix_lines):
        if l.kind == "caption" and EXHIBIT_CAPTION.search(_CAPTION.sub("", l.text)):
            doc.exhibits.append(Exhibit(kind="caption", where="Appendix", snippet=l.text[:220]))
    # monospace or I/O-marked blocks
    blocks = defaultdict(list)
    for j, l in enumerate(lines):
        blocks[(l.page, l.block)].append((j, l))
    for key, bl in blocks.items():
        js = [j for j, _ in bl]
        if js[0] in sec_of_line and sec_of_line[js[0]] in related:
            continue
        if js[0] >= end_body and ref_start is not None and not any(l in appendix_lines for _, l in bl[:1]):
            continue
        mono = sum(1 for _, l in bl if l.mono)
        io = any(_IO_MARKER.match(l.text) for _, l in bl)
        if (mono >= 2 and mono >= 0.6 * len(bl)) or (io and len(bl) >= 2):
            where = doc.section(sec_of_line[js[0]]).title if js[0] in sec_of_line else "Appendix"
            doc.exhibits.append(Exhibit(kind="environment", where=where,
                                        snippet=_norm(" ".join(l.text for _, l in bl))[:220]))
    for s in doc.sections:
        if s.idx in related:
            continue
        body = " ".join(x.text for x in s.sentences)
        for qm in re.finditer(r"[“\"]([^”\"]{60,1200})[”\"]", body):
            if len(qm.group(1).split()) >= 20:
                doc.exhibits.append(Exhibit(kind="quotation", where=s.title, snippet=qm.group(1)[:220]))
    body_prose = " ".join(x.text for s in doc.sections for x in s.sentences)
    doc.gap_acknowledged = bool(ACK_GAP.search(body_prose))

    for s in doc.sections:
        if doc.intro_idx is None and _INTRO.search(s.title):
            doc.intro_idx = s.idx
        if _RELATED.search(s.title) and not _INTRO.search(s.title):
            doc.related_idx.append(s.idx)
    if doc.intro_idx is None and doc.sections:
        doc.intro_idx = doc.sections[0].idx

    doc.stats.update({
        "pages": info["pages"], "body_sections": len(doc.sections), "objects": len(doc.objects),
        "figures": len(doc.figures), "tables": len(doc.tables),
        "body_words": sum(s.n_words for s in doc.sections), "has_appendix": bool(appendix_lines),
    })
    return doc


def _table_numbers(pdf, lines: list[Line], j: int, cap: Line) -> tuple[int, int]:
    """Count data rows and numeric cells of the table whose caption is lines[j]."""
    page = pdf[cap.page]
    W = page.rect.width
    x0, x1 = (0, W) if cap.x1 - cap.x0 > W * 0.55 or cap.x0 < W * 0.3 and cap.x1 > W * 0.7 else (
        (0, W / 2) if cap.x1 <= W / 2 + 12 else (W / 2, W))
    # table body is usually below the caption; fall back to above. A prose line ends the scan.
    def prose(t: str) -> bool:
        words = t.split()
        nums = len(re.findall(r"\d", t))
        return len(words) > 9 and nums < 3 and sum(1 for w in words if w.islower()) > len(words) * 0.5

    best = (0, 0)
    for direction in (1, -1):
        rows = defaultdict(list)
        k = j + direction
        started = False
        while 0 <= k < len(lines) and abs(k - j) < 150:
            l = lines[k]
            if l.page != cap.page or l.kind in ("heading", "caption"):
                break
            if l.kind == "caption_cont" or not (x0 - 5 <= l.x0 and l.x1 <= x1 + 5):
                k += direction
                continue
            if prose(l.text) or (len(l.text.split()) > 14 and started):
                break
            started = True
            rows[round(l.y0 / 3)].append(l.text)
            k += direction
        dr = nc = 0
        for _, cells in rows.items():
            n = sum(len(re.findall(r"(?<![A-Za-z])[+\-−±]?\d+(?:[.,]\d+)?%?(?![A-Za-z])", c)) for c in cells)
            if n:
                dr += 1
                nc += n
        if (dr, nc) > best:
            best = (dr, nc)
        if best[0] >= 2 and best[1] >= 4:
            break
    return best


def _figure_region(pdf, lines: list[Line], j: int, body_size: float) -> Optional[tuple]:
    """Page region of the figure whose caption is lines[j]: the union of drawings, images and figure labels
    between the prose above and the caption."""
    cap = lines[j]
    page = pdf[cap.page]
    W, H = page.rect.width, page.rect.height
    full = cap.x1 - cap.x0 > W * 0.55 or (cap.x0 < W * 0.3 and cap.x1 > W * 0.62)
    if full:
        x0, x1 = W * 0.04, W * 0.96
    elif cap.x1 <= W / 2 + 12:
        x0, x1 = W * 0.03, W / 2 + 8
    else:
        x0, x1 = W / 2 - 8, W * 0.97
    top = H * 0.075
    for l in lines:
        if l.page != cap.page or l.y1 > cap.y0 - 2 or l.x1 < x0 or l.x0 > x1:
            continue
        if l.kind in ("text", "heading", "caption", "caption_cont") and abs(l.size - body_size) <= 0.75 and len(l.text) > 45:
            top = max(top, l.y1 + 2)
    band = pymupdf.Rect(x0, top, x1, cap.y0 - 1)
    if band.height < 30:
        return None
    rects = []
    try:
        for info in page.get_image_info():
            r = pymupdf.Rect(info["bbox"]) & band
            if not r.is_empty and r.width > 8 and r.height > 8:
                rects.append(r)
        for d in page.get_drawings():
            r = pymupdf.Rect(d["rect"])
            if r.intersects(band) and not (r.width > W * 0.9 and r.height < 2):
                rr = r & band
                if not rr.is_empty:
                    rects.append(rr)
    except Exception:
        pass
    for l in lines:
        if l.page == cap.page and l.kind in ("text", "small", "table") and band.contains(pymupdf.Rect(l.x0, l.y0, l.x1, l.y1)) \
                and (abs(l.size - body_size) > 0.75 or len(l.text) <= 45):
            rects.append(pymupdf.Rect(l.x0, l.y0, l.x1, l.y1))
    if rects:
        u = rects[0]
        for r in rects[1:]:
            u |= r
        u = pymupdf.Rect(u.x0 - 4, u.y0 - 4, u.x1 + 4, u.y1 + 4) & band
        if u.height >= 30 and u.width >= 40:
            band = u
    return (cap.page, band.x0, band.y0, band.x1, band.y1)


def _reference_names(refs: list[Line], style: str) -> dict[str, list[str]]:
    """Names the cited works go by (title acronyms before a colon), keyed like the in-text citations."""
    text = "\n".join(l.text for l in refs)
    entries: list[str] = []
    if style == "numeric":
        parts = re.split(r"\n?\[(\d{1,3})\]\s*", text)
        for k in range(1, len(parts) - 1, 2):
            entries.append((f"ref{int(parts[k])}", parts[k + 1]))
    else:
        cur = []
        base_x = min((l.x0 for l in refs), default=0)
        for l in refs:
            if abs(l.x0 - base_x) < 3 and cur:
                entries.append(" ".join(cur))
                cur = []
            cur.append(l.text)
        if cur:
            entries.append(" ".join(cur))
        out = []
        for e in entries:
            fm = re.match(r"\s*([A-Z][A-Za-z\-'’À-ž]+)", e)
            ym = re.search(r"\b((?:19|20)\d{2}[a-z]?)\b", e)
            # surname: first "Lastname," or last token of the first author
            sm = re.match(r"\s*([^,.]+?)[,.]", e)
            sur = None
            if sm:
                toks = sm.group(1).split()
                sur = toks[-1] if toks else None
            if sur and ym:
                out.append((f"{sur}{ym.group(1)}".lower(), e))
            elif fm and ym:
                out.append((f"{fm.group(1)}{ym.group(1)}".lower(), e))
        entries = out
    names: dict[str, list[str]] = {}
    for key, e in entries:
        m = re.search(r"(?:^|[.?]\s+)([A-Z][\w\-]*(?:\s[\w\-]+){0,2}):\s", e[:260])
        if m and re.search(r"[A-Z]", m.group(1)[1:]) and len(m.group(1)) >= 3:
            names.setdefault(key, []).append(m.group(1))
    return names


_DEST_KIND = {"section": "section", "subsection": "section", "subsubsection": "section", "chapter": "section",
              "paragraph": "section", "figure": "figure", "subfigure": "figure", "table": "table",
              "subtable": "table", "equation": "equation", "AMS": "equation", "algorithm": "algorithm",
              "algocf": "algorithm", "ALC@": "algorithm"}


def _link_pointers(pdf, lines: list[Line], sec_of_line: dict, end_body: int, anchors: list, doc: Document) -> int:
    """Pointers from internal PDF links. The destination name gives the object kind; the nearest anchor of
    that kind at or below the destination point gives the object."""
    by_page = defaultdict(list)
    for j, l in enumerate(lines):
        by_page[l.page].append((j, l))
    anc_by_page = defaultdict(list)
    for kind, j, oid in anchors:
        l = lines[j]
        anc_by_page[l.page].append((kind, l, oid))
    end_line = lines[end_body] if end_body < len(lines) else None
    n = 0
    for pno, page in enumerate(pdf):
        H = page.rect.height
        for ln in page.get_links():
            name = ln.get("nameddest") or ""
            if ln.get("kind") not in (pymupdf.LINK_GOTO, pymupdf.LINK_NAMED) or "page" not in ln or ln.get("page", -1) < 0:
                continue
            prefix = name.split(".")[0]
            if not name or prefix in ("cite", "Hfootnote", "page", "Item", "lstlisting", "lstnumber", "Doc-Start"):
                continue
            r = ln["from"]
            cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            src = None
            for j, l in by_page[pno]:
                if l.x0 - 2 <= cx <= l.x1 + 2 and l.y0 - 2 <= cy <= l.y1 + 2:
                    src = sec_of_line.get(j)
                    break
            if src is None:
                continue
            tp, to = ln["page"], ln.get("to")
            ty = pdf[tp].rect.height - to.y if to is not None else 0
            tx = to.x if to is not None else 0
            if prefix == "appendix" or (end_line is not None and (tp > end_line.page or (tp == end_line.page and ty >= end_line.y0 - 2))):
                doc.pointers.append(Pointer(src=src, target="appendix:" + name, via="link", pos=int(cy)))
                n += 1
                continue
            want = _DEST_KIND.get(prefix)
            best, bd = None, 1e9
            W = pdf[tp].rect.width
            for kind, l, oid in anc_by_page[tp]:
                if want and kind != want:
                    continue
                dy = l.y0 - ty
                if dy < -14:
                    if not (kind == "table" and dy > -60):
                        continue
                same_col = (l.x0 < W / 2 + 12) == (tx < W / 2 + 12) or l.x1 - l.x0 > W * 0.55
                d = abs(dy) + (0 if same_col else 400)
                if d < bd:
                    best, bd = oid, d
            if best is None or bd > 760:
                continue
            doc.pointers.append(Pointer(src=src, target=best, via="link", pos=int(cy)))
            n += 1
    return n
