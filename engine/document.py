"""Document model shared by the LaTeX and PDF readers.

A paper is read into two views (Appendix A of the paper):
  * the structure view: sections, labeled objects, references, citations, floats;
  * the prose view: sentences with math / citations / references replaced by sentinels.
Both readers fill the same dataclasses so the six measures never care where a paper came from.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Sentence:
    text: str                      # display text; sentinels shown as [cite] / [math] / [ref]
    cites: list[list[str]] = field(default_factory=list)   # one key group per [cite] occurrence, in order

    @property
    def keys(self) -> list[str]:
        return [k for g in self.cites for k in g]


@dataclass
class Section:
    idx: int                       # 0 = abstract, 1.. = body sections in document order
    title: str
    number: Optional[str]          # printed number ("3"), None for unnumbered
    sentences: list[Sentence] = field(default_factory=list)   # prose view
    kind: str = "body"             # abstract | body

    @property
    def n_words(self) -> int:
        return sum(len(s.text.split()) for s in self.sentences)


@dataclass
class Obj:
    """Something the paper declares and can point to: a body section or a labeled float/equation."""
    id: str
    kind: str                      # section | figure | table | equation | algorithm | theorem
    home: int                      # index of the section that holds it
    aliases: list[str] = field(default_factory=list)
    caption: str = ""
    number: Optional[str] = None   # printed number, used by the PDF reader and printed mentions
    display: str = ""              # short human name, e.g. "Table 2" or "§3 Method"
    loc: Optional[tuple] = None    # (page, x0, y0, x1, y1) of its heading / caption / number, PDF reader only


@dataclass
class Pointer:
    src: int                       # section index the pointer sits in
    target: str                    # Obj.id, or "appendix:<name>" for appendix pointers
    via: str                       # ref | number | name
    pos: int                       # order inside the source section (for the roadmap rule)
    context: str = ""
    roadmap: bool = False


@dataclass
class Table:
    home: int
    label: str
    caption: str
    data_rows: int
    numeric_cells: int


@dataclass
class Figure:
    home: int
    label: str
    caption: str
    number: Optional[str] = None
    images: list[str] = field(default_factory=list)   # file paths of the figure images (PNG/JPG/PDF)
    pdf_clip: Optional[tuple] = None                  # (pdf_path, page_no, x0, y0, x1, y1) for PDF input


@dataclass
class Exhibit:
    kind: str                      # environment | caption | quotation
    where: str                     # section title or "appendix"
    snippet: str


@dataclass
class Document:
    source: str                    # latex | pdf
    title: str = ""
    abstract: Optional[Section] = None
    sections: list[Section] = field(default_factory=list)
    objects: list[Obj] = field(default_factory=list)
    pointers: list[Pointer] = field(default_factory=list)
    tables: list[Table] = field(default_factory=list)
    figures: list[Figure] = field(default_factory=list)
    exhibits: list[Exhibit] = field(default_factory=list)
    gap_acknowledged: bool = False
    intro_idx: Optional[int] = None
    related_idx: list[int] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    work_names: dict = field(default_factory=dict)   # citation key -> names the work goes by in text
    warnings: list[str] = field(default_factory=list)
    workdir: Optional[str] = None

    def section(self, idx: int) -> Section:
        if idx == 0 and self.abstract is not None:
            return self.abstract
        for s in self.sections:
            if s.idx == idx:
                return s
        raise KeyError(idx)

    def prose_sections(self) -> list[Section]:
        """Abstract (if any) followed by the body sections, in order."""
        return ([self.abstract] if self.abstract else []) + list(self.sections)

    def outline(self) -> list[dict]:
        return [
            {"idx": s.idx, "title": s.title, "number": s.number, "words": s.n_words,
             "sentences": len(s.sentences), "kind": s.kind}
            for s in self.prose_sections()
        ]
