"""LaTeX source reader (Appendix A, "Document views").

Expands every \\input of the project into one document, strips comments, expands user macros,
cuts the body before the appendix / acknowledgements / bibliography, and builds the structure
view (sections, labeled objects, pointers, tables, figures, exhibits) and the prose view.
"""
from __future__ import annotations

import os
import re
from typing import Optional

from .document import Document, Exhibit, Figure, Obj, Pointer, Section, Sentence, Table
from .text import CITE_MARK, split_sentences

# ----------------------------------------------------------------------------- low-level parsing

def match_group(s: str, i: int, open_: str = "{", close: str = "}") -> int:
    """Index of the bracket closing the one at s[i]; -1 if unbalanced. Skips escaped chars."""
    depth, n, k = 0, len(s), i
    brace = 0
    while k < n:
        c = s[k]
        if c == "\\":
            k += 2
            continue
        if open_ == "[":
            if c == "{":
                brace += 1
            elif c == "}":
                brace -= 1
            elif brace == 0 and c == "[":
                depth += 1
            elif brace == 0 and c == "]":
                depth -= 1
                if depth == 0:
                    return k
        else:
            if c == open_:
                depth += 1
            elif c == close:
                depth -= 1
                if depth == 0:
                    return k
        k += 1
    return -1


def _skip_ws(s: str, i: int) -> int:
    n = len(s)
    while i < n and s[i] in " \t\r" or (i < n and s[i] == "\n" and not s[i + 1:i + 2] == "\n"):
        i += 1
    return i


def read_args(s: str, i: int, n_req: int, max_opt: int = 2, greedy: bool = False):
    """Read optional [..] groups then brace groups starting at s[i].

    Returns (opts, args, end). With greedy=True read every adjacent brace group (unknown commands).
    """
    opts, args = [], []
    j = i if greedy else _skip_ws(s, i)
    while len(opts) < max_opt and j < len(s) and s[j] == "[":
        e = match_group(s, j, "[", "]")
        if e < 0:
            break
        opts.append(s[j + 1:e])
        i = e + 1
        j = i if greedy else _skip_ws(s, i)
    while (greedy or len(args) < n_req) and j < len(s) and s[j] == "{":
        e = match_group(s, j)
        if e < 0:
            break
        args.append(s[j + 1:e])
        i = e + 1
        j = _skip_ws(s, i) if not greedy else i
        # optional groups may sit between brace groups (\parbox[t]{w}{x})
        while j < len(s) and s[j] == "[" and len(args) < n_req:
            e = match_group(s, j, "[", "]")
            if e < 0:
                break
            opts.append(s[j + 1:e])
            i = e + 1
            j = _skip_ws(s, i)
    return opts, args, i


def strip_comments(src: str) -> str:
    src = re.sub(r"\\begin\{comment\}.*?\\end\{comment\}", "", src, flags=re.S)
    out = []
    for line in src.split("\n"):
        cut, i = None, 0
        while True:
            j = line.find("%", i)
            if j < 0:
                break
            k, nb = j - 1, 0
            while k >= 0 and line[k] == "\\":
                nb += 1
                k -= 1
            if nb % 2 == 0:
                cut = j
                break
            i = j + 1
        if cut is not None:
            line = line[:cut]
            if not line.strip():
                continue          # a comment-only line vanishes, as in TeX
        out.append(line)
    text = "\n".join(out)
    text = re.sub(r"\\iffalse\b.*?\\fi\b", "", text, flags=re.S)
    return text


# ----------------------------------------------------------------------------- project expansion

def _read(path: str) -> str:
    with open(path, "rb") as f:
        raw = f.read()
    for enc in ("utf-8", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "ignore")


def _resolve(root: str, cur_dir: str, name: str, exts=(".tex", "")) -> Optional[str]:
    name = name.strip().strip('"')
    for base in (root, cur_dir):
        for ext in exts:
            p = os.path.normpath(os.path.join(base, name + ext if not name.endswith(ext) or not ext else name))
            if os.path.isfile(p) and os.path.realpath(p).startswith(os.path.realpath(root)):
                return p
    return None


_INPUT = re.compile(r"\\(input|include|subfile)\s*\{([^}]*)\}|\\input\s+([^\s{}\\]+)")


def expand_inputs(text: str, root: str, cur_dir: str, depth: int = 0, seen: Optional[set] = None) -> str:
    seen = seen if seen is not None else set()

    def repl(m):
        name = (m.group(2) or m.group(3) or "").strip()
        p = _resolve(root, cur_dir, name)
        if not p or depth > 15 or p in seen:
            return ""
        seen.add(p)
        sub = strip_comments(_read(p))
        return "\n" + expand_inputs(sub, root, os.path.dirname(p), depth + 1, seen) + "\n"

    return _INPUT.sub(repl, text)


def find_main_tex(root: str) -> Optional[str]:
    cands = []
    for dp, _, files in os.walk(root):
        for f in files:
            if f.lower().endswith(".tex"):
                p = os.path.join(dp, f)
                try:
                    t = strip_comments(_read(p))
                except OSError:
                    continue
                if "\\documentclass" in t and "\\begin{document}" in t:
                    score = t.count("\\input") + t.count("\\section") + len(t) / 5000
                    if f.lower() in ("main.tex", "paper.tex", "ms.tex"):
                        score += 5
                    cands.append((score, p))
    if not cands:
        return None
    return max(cands)[1]


# ----------------------------------------------------------------------------- macros

_COMPLEX = re.compile(
    r"\\(tikz|node|draw|setbox|rule|kern|raisebox|hbox|vbox|marginpar|includegraphics|begin|end|def|"
    r"ifx|ifdim|else|fi|color|scalebox|resizebox|makebox|parbox|vskip|hskip|noalign|specialrule|"
    r"arrayrulecolor|dimexpr|rowcolor|cellcolor|multicolumn|multirow|expandafter|csname|let|global|"
    r"setul|sethlcolor|usefont|fontsize|selectfont|wd|ht|dp|linewidth|hrule|vrule|leaders|hss|"
    r"tcbset|pgf|foreach|rotatebox|reflectbox|phantom|hspace|vspace)\b")

_DEF = re.compile(r"\\(newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*")
_ENVDEF = re.compile(r"\\(newenvironment|renewenvironment|newtcolorbox|DeclareTColorBox|newmdenv|"
                     r"newtheorem|declaretheorem|newtcbtheorem|lstnewenvironment)\*?\s*")


class Macros:
    def __init__(self):
        self.cmds: dict[str, tuple[int, Optional[str], str]] = {}
        self.env_nargs: dict[str, int] = {}
        self.theorems: set[str] = set()

    def harvest(self, text: str) -> str:
        """Record \\newcommand-style definitions and return the text with the definitions removed."""
        spans = []
        for m in _DEF.finditer(text):
            pos = _skip_ws(text, m.end())
            if pos >= len(text):
                continue
            if text[pos] == "{":
                e = match_group(text, pos)
                if e < 0:
                    continue
                name = text[pos + 1:e].strip()
                pos = e + 1
            else:
                mm = re.match(r"\\[A-Za-z@]+", text[pos:])
                if not mm:
                    continue
                name = mm.group(0)
                pos += mm.end()
            nargs, default = 0, None
            pos = _skip_ws(text, pos)
            if pos < len(text) and text[pos] == "[":
                e = match_group(text, pos, "[", "]")
                try:
                    nargs = int(text[pos + 1:e].strip())
                except ValueError:
                    nargs = 0
                pos = _skip_ws(text, e + 1)
                if pos < len(text) and text[pos] == "[":
                    e = match_group(text, pos, "[", "]")
                    default = text[pos + 1:e]
                    pos = _skip_ws(text, e + 1)
            if pos >= len(text) or text[pos] != "{":
                continue
            e = match_group(text, pos)
            if e < 0:
                continue
            body = text[pos + 1:e]
            key = name.lstrip("\\")
            if not (m.group(1) == "providecommand" and key in self.cmds):
                self.cmds[key] = (nargs, default, body)
            spans.append((m.start(), e + 1))
        for m in re.finditer(r"\\def\s*\\([A-Za-z@]+)((?:#\d)*)\s*\{", text):
            e = match_group(text, m.end() - 1)
            if e < 0:
                continue
            nargs = len(m.group(2)) // 2
            self.cmds[m.group(1)] = (nargs, None, text[m.end():e])
            spans.append((m.start(), e + 1))
        for m in _ENVDEF.finditer(text):
            kind = m.group(1)
            pos = _skip_ws(text, m.end())
            if pos >= len(text) or text[pos] != "{":
                continue
            e = match_group(text, pos)
            name = text[pos + 1:e].strip()
            opts, args, end = read_args(text, e + 1, {"newenvironment": 2, "renewenvironment": 2,
                                                       "newtheorem": 1, "declaretheorem": 0,
                                                       "lstnewenvironment": 2}.get(kind, 1), max_opt=2)
            if kind in ("newtheorem", "declaretheorem", "newtcbtheorem"):
                self.theorems.add(name)
            else:
                n = 0
                if opts:
                    try:
                        n = int(opts[0].strip())
                    except ValueError:
                        n = 0
                self.env_nargs[name] = n
            spans.append((m.start(), end))
        if not spans:
            return text
        spans.sort()
        out, last = [], 0
        for a, b in spans:
            if a < last:
                continue
            out.append(text[last:a])
            last = b
        out.append(text[last:])
        return "".join(out)

    def expand(self, text: str, passes: int = 8) -> str:
        if not self.cmds:
            return text
        names = sorted(self.cmds, key=len, reverse=True)
        pat = re.compile(r"\\(" + "|".join(re.escape(n) for n in names) + r")(?![A-Za-z@])")
        for _ in range(passes):
            changed = False
            out, i = [], 0
            for m in pat.finditer(text):
                if m.start() < i:
                    continue
                name = m.group(1)
                nargs, default, body = self.cmds[name]
                end = m.end()
                args = []
                if nargs:
                    j = end
                    if default is not None:
                        jj = _skip_ws(text, j)
                        if jj < len(text) and text[jj] == "[":
                            e = match_group(text, jj, "[", "]")
                            args.append(text[jj + 1:e])
                            j = e + 1
                        else:
                            args.append(default)
                    while len(args) < nargs:
                        jj = _skip_ws(text, j)
                        if jj < len(text) and text[jj] == "{":
                            e = match_group(text, jj)
                            if e < 0:
                                break
                            args.append(text[jj + 1:e])
                            j = e + 1
                        elif jj < len(text) and text[jj] == "\\":
                            mm = re.match(r"\\[A-Za-z@]+|\\.", text[jj:])
                            args.append(mm.group(0))
                            j = jj + mm.end()
                        elif jj < len(text):
                            args.append(text[jj])
                            j = jj + 1
                        else:
                            break
                    end = j
                if _COMPLEX.search(body):
                    rep = ("{" + args[-1] + "}") if args else ""
                else:
                    rep = body
                    for k, a in enumerate(args, 1):
                        rep = rep.replace("#" + str(k), a)
                    # no brace wrapping: aliases such as \renewcommand{\cite}{\citep} must still take their args
                out.append(text[i:m.start()])
                out.append(rep)
                i = end
                changed = True
            out.append(text[i:])
            text = "".join(out)
            if not changed:
                break
        return text


# ----------------------------------------------------------------------------- LaTeX -> text

FLOAT_KIND = {
    "figure": "figure", "figure*": "figure", "wrapfigure": "figure", "SCfigure": "figure",
    "sidewaysfigure": "figure", "table": "table", "table*": "table", "wraptable": "table",
    "sidewaystable": "table", "algorithm": "algorithm", "algorithm*": "algorithm",
    "algorithm2e": "algorithm",
}
MATH_ENVS = {e + s for e in ("equation", "align", "gather", "multline", "eqnarray", "flalign",
                             "alignat", "displaymath", "math", "split", "dmath", "IEEEeqnarray")
             for s in ("", "*")}
BASE_THEOREMS = {"theorem", "lemma", "proposition", "corollary", "definition", "remark",
                 "assumption", "claim", "conjecture", "hypothesis", "observation", "property", "fact"}
DROP_ENVS = set(FLOAT_KIND) | {"tabular", "tabular*", "tabularx", "tabulary", "longtable", "tikzpicture",
                               "lstlisting", "verbatim", "Verbatim", "minted", "algorithmic", "thebibliography",
                               "subfigure", "subtable", "minipage", "center", "adjustbox", "picture", "pgfpicture",
                               "comment", "filecontents"}
LIST_ENVS = {"itemize", "enumerate", "description", "compactitem", "compactenum", "inparaenum", "list"}
KNOWN_ENV_ARGS = {"minipage": 1, "tabular": 1, "tabular*": 2, "tabularx": 2, "tabulary": 2, "wrapfigure": 2,
                  "wraptable": 2, "subfigure": 1, "subtable": 1, "multicols": 1, "adjustbox": 1, "longtable": 1,
                  "tcolorbox": 0, "list": 2, "alignat": 1, "alignat*": 1, "otherlanguage": 1}

CITE_CMDS = {"cite", "citep", "citet", "citealt", "citealp", "citeauthor", "citeyear", "citeyearpar",
             "parencite", "textcite", "autocite", "Citet", "Citep", "Citealt", "Citealp", "Cite", "Autocite",
             "Textcite", "Parencite", "footcite", "supercite", "citenum", "smartcite", "nocite"}
REF_CMDS = {"ref", "eqref", "autoref", "Autoref", "cref", "Cref", "cpageref", "Cpageref", "pageref",
            "nameref", "vref", "Vref", "subref", "labelcref", "namecref", "nameCref", "crefrange", "Crefrange"}
KEEP1 = {"textbf", "textit", "emph", "textsc", "texttt", "textrm", "textsf", "textup", "textmd", "textnormal",
         "underline", "uline", "mbox", "text", "hl", "MakeUppercase", "MakeLowercase", "uppercase",
         "lowercase", "fbox", "framebox", "textsl", "boldsymbol", "mathrm", "bm", "enquote", "strong",
         "textsuperscript", "textsubscript", "ul", "st", "so", "caps", "sout", "xout",
         "textls", "smash", "centerline", "textbfit"}
NOARG = {"centering", "raggedright", "raggedleft", "small", "footnotesize", "scriptsize", "tiny", "large", "Large",
         "LARGE", "huge", "Huge", "normalsize", "noindent", "indent", "clearpage", "cleardoublepage", "newpage",
         "maketitle", "xspace", "sloppy", "fussy", "raggedbottom", "flushbottom", "hfill", "vfill", "hfil", "vfil",
         "bigskip", "medskip", "smallskip", "bf", "it", "em", "rm", "sf", "tt", "sc", "sl", "bfseries", "itshape",
         "mdseries", "upshape", "normalfont", "ttfamily", "sffamily", "rmfamily", "scshape", "protect", "relax",
         "null", "nobreak", "allowbreak", "displaystyle", "textstyle", "appendix", "tableofcontents", "today",
         "toprule", "midrule", "bottomrule", "hline", "endgroup", "begingroup", "makeatletter", "makeatother",
         "onecolumn", "strut", "unskip", "ignorespaces", "leavevmode", "selectfont", "hss", "break",
         "pagebreak", "nopagebreak", "frenchspacing", "nonfrenchspacing", "iclrfinalcopy", "headrow", "oursrow",
         "tabularnewline", "footnotemark", "baselineskip", "linewidth", "textwidth", "columnwidth", "hsize",
         "bottomcaption", "topcaption", "FloatBarrier", "justify", "arraybackslash", "newblock", "sffamily",
         "bibpunct", "stepcounter", "smallbreak", "medbreak", "bigbreak", "bgroup", "egroup", "boldmath"}
KEEP_LAST = {"textcolor": 2, "colorbox": 2, "href": 2, "fcolorbox": 3, "raisebox": 2, "scalebox": 2,
             "resizebox": 3, "parbox": 2, "foreignlanguage": 2, "multicolumn": 3, "multirow": 3,
             "makecell": 1, "shortstack": 1, "rotatebox": 2, "hyperlink": 2, "hypertarget": 2, "texorpdfstring": 2,
             "adjustbox": 2, "ding": 1, "tikzmark": 1, "tcbox": 1, "SetCell": 1, "cellcolor": 2}
DROP_ARGS = {"vspace": 1, "hspace": 1, "setlength": 2, "addtolength": 2, "setcounter": 2, "addtocounter": 2,
             "stepcounter": 1, "refstepcounter": 1, "color": 1, "definecolor": 3, "colorlet": 2,
             "captionsetup": 1, "label": 1, "input": 1, "include": 1, "bibliographystyle": 1, "bibliography": 1,
             "includegraphics": 1, "rowcolor": 1, "arrayrulecolor": 1, "usetikzlibrary": 1, "pgfplotsset": 1,
             "hypersetup": 1, "sethlcolor": 1, "cline": 1, "specialrule": 3, "fontsize": 2, "usefont": 4,
             "setul": 2, "bibitem": 1, "footnote": 1, "footnotetext": 1, "thanks": 1, "marginpar": 1,
             "caption": 1, "captionof": 2, "subcaption": 1, "url": 1, "nolinkurl": 1, "urlstyle": 1,
             "pagestyle": 1, "thispagestyle": 1, "linespread": 1, "vskip": 0, "newpage": 0, "iclrfinalcopy": 0,
             "graphicspath": 1, "DeclareGraphicsExtensions": 1, "enlargethispage": 1, "phantom": 1,
             "hphantom": 1, "vphantom": 1, "wrapfigure": 2, "setstretch": 1, "renewcommand": 2,
             "newcommand": 2, "providecommand": 2, "author": 1, "affil": 1, "email": 1, "date": 1,
             "title": 1, "keywords": 1, "lstinputlisting": 1, "tikz": 1, "ifthenelse": 3, "setuldepth": 1,
             "settowidth": 2, "addcontentsline": 3, "setcitestyle": 1, "numberwithin": 2, "doi": 1,
             "orcid": 1, "hdashline": 0, "cmidrule": 1, "addlinespace": 0, "tnote": 1, "icon": 1,
             "faIcon": 1, "institute": 1, "IEEEauthorblockN": 1, "IEEEauthorblockA": 1, "icmltitle": 1,
             "icmlauthor": 2, "icmlaffiliation": 2, "icmlcorrespondingauthor": 2, "icmlkeywords": 1,
             "twocolumn": 0, "resizebox*": 2, "savebox": 1, "sbox": 2, "usebox": 1, "newsavebox": 1,
             "belowcaptionskip": 0, "abovecaptionskip": 0}
SYMBOLS = {"ldots": "...", "dots": "...", "cdots": "...", "textendash": "–", "textemdash": "—", "LaTeX": "LaTeX",
           "TeX": "TeX", "times": "×", "textperiodcentered": "·", "checkmark": "✓", "S": "§", "ss": "ß",
           "textasciitilde": "~", "textbackslash": "\\", "quad": " ", "qquad": " ", "enspace": " ",
           "thinspace": " ", "newline": " ", "linebreak": " ", "par": "\n\n", "textbullet": "•",
           "textdagger": "†", "dag": "†", "ddag": "‡", "pm": "±", "textpm": "±", "approx": "≈",
           "textdegree": "°", "degree": "°", "euro": "€", "pounds": "£", "copyright": "©", "textregistered": "®",
           "texttrademark": "™", "xmark": "✗", "cmark": "✓", "ding": "", "rightarrow": "→", "to": "→",
           "leftarrow": "←", "uparrow": "↑", "downarrow": "↓", "Rightarrow": "⇒", "ge": "≥", "le": "≤",
           "geq": "≥", "leq": "≤", "neq": "≠", "sim": "~", "infty": "∞", "alpha": "α", "beta": "β",
           "tau": "τ", "lambda": "λ", "rho": "ρ", "delta": "δ", "epsilon": "ε", "mu": "μ", "sigma": "σ",
           "item": "\n\n", "and": ", ", "AND": ", ", "And": ", ", "slash": "/", "textquotedblleft": "“",
           "textquotedblright": "”", "textquoteleft": "‘", "textquoteright": "’", "o": "ø", "O": "Ø",
           "ae": "æ", "AE": "Æ", "aa": "å", "i": "i", "l": "ł", "L": "Ł"}
_SECTION_CMDS = {"part", "chapter", "section", "subsection", "subsubsection"}
_PARA_CMDS = {"paragraph", "subparagraph"}


class Tex2Text:
    """Recursive LaTeX -> text converter producing the prose view.

    Floats, captions, footnotes and tables are dropped; math becomes [math]; references become [ref];
    citations become ⟦c:key1,key2⟧ markers that the sentence builder turns into [cite].
    """

    def __init__(self, env_nargs: Optional[dict] = None):
        self.env_nargs = dict(KNOWN_ENV_ARGS)
        if env_nargs:
            self.env_nargs.update(env_nargs)

    def __call__(self, s: str) -> str:
        out = self._conv(s)
        out = re.sub(r"[ \t\r]+", " ", out)
        out = re.sub(r" *\n *", "\n", out)
        out = re.sub(r"\n{3,}", "\n\n", out)
        out = re.sub(r"\s+([,.;:!?)])", r"\1", out)
        out = re.sub(r"\(\s+", "(", out)
        return out.strip()

    def _skip_env(self, s: str, i: int, name: str) -> int:
        """i points just after \\begin{name}; return index after the matching \\end{name}."""
        pat = re.compile(r"\\(begin|end)\s*\{" + re.escape(name) + r"\}")
        depth = 1
        for m in pat.finditer(s, i):
            depth += 1 if m.group(1) == "begin" else -1
            if depth == 0:
                return m.end()
        return len(s)

    def _conv(self, s: str) -> str:
        out: list[str] = []
        i, n = 0, len(s)
        while i < n:
            c = s[i]
            if c == "\\":
                if i + 1 >= n:
                    break
                d = s[i + 1]
                if not d.isalpha() and d != "@":
                    if d == "(":
                        e = s.find("\\)", i + 2)
                        out.append(" [math] ")
                        i = n if e < 0 else e + 2
                        continue
                    if d == "[":
                        e = s.find("\\]", i + 2)
                        out.append(" [math] ")
                        i = n if e < 0 else e + 2
                        continue
                    if d in "'\"`^~=." and i + 2 < n:
                        # accents: \'e, \"{o}
                        j = i + 2
                        if s[j] == "{":
                            e = match_group(s, j)
                            out.append(self._conv(s[j + 1:e]) if e > 0 else "")
                            i = e + 1 if e > 0 else n
                        else:
                            out.append(s[j] if s[j].isalpha() else "")
                            i = j + 1
                        continue
                    if d == "\\":
                        # line break, possibly with a spacing argument: \\[2pt]
                        j = i + 2
                        if j < n and s[j] == "*":
                            j += 1
                        if j < n and s[j] == "[":
                            e = match_group(s, j, "[", "]")
                            j = e + 1 if e > 0 else j
                        out.append(" ")
                        i = j
                        continue
                    out.append({"\\": " ", ",": " ", ";": " ", "!": "", " ": " ", "-": "", "@": "", "/": "",
                                "%": "%", "&": "&", "_": "_", "#": "#", "$": "$", "{": "{", "}": "}",
                                "|": "‖"}.get(d, ""))
                    i += 2
                    continue
                m = re.match(r"[A-Za-z@]+\*?", s[i + 1:])
                name = m.group(0)
                bare = name.rstrip("*")
                i = i + 1 + m.end()
                if bare == "begin":
                    _, args, j = read_args(s, i, 1, max_opt=0)
                    env = args[0].strip() if args else ""
                    if env in MATH_ENVS:
                        out.append(" [math] ")
                        i = self._skip_env(s, j, env)
                    elif env in DROP_ENVS:
                        i = self._skip_env(s, j, env)
                        out.append("\n\n")
                    else:
                        nargs = self.env_nargs.get(env, 0)
                        _, _, j = read_args(s, j, nargs, max_opt=1)
                        out.append("\n\n" if env in LIST_ENVS or env in ("abstract", "quote", "quotation") else " ")
                        i = j
                    continue
                if bare == "end":
                    _, args, j = read_args(s, i, 1, max_opt=0)
                    env = args[0].strip() if args else ""
                    out.append("\n\n" if env in LIST_ENVS or env in ("abstract", "quote", "quotation") else " ")
                    i = j
                    continue
                if bare in CITE_CMDS:
                    _, args, j = read_args(s, i, 1, max_opt=2)
                    keys = ",".join(k.strip() for k in (args[0] if args else "").split(",") if k.strip())
                    if bare != "nocite":
                        out.append(f" ⟦c:{keys}⟧ ")
                    i = j
                    continue
                if bare in REF_CMDS:
                    _, _, j = read_args(s, i, 2 if bare in ("crefrange", "Crefrange") else 1, max_opt=0)
                    out.append(" [ref] ")
                    i = j
                    continue
                if bare == "hyperref":
                    _, args, j = read_args(s, i, 1, max_opt=1)
                    out.append(" [ref] ")
                    i = j
                    continue
                if bare == "verb":
                    if i < n:
                        delim = s[i]
                        e = s.find(delim, i + 1)
                        out.append(s[i + 1:e] if e > 0 else "")
                        i = n if e < 0 else e + 1
                    continue
                if bare in _SECTION_CMDS:
                    _, _, j = read_args(s, i, 1, max_opt=1)
                    out.append("\n\n")
                    i = j
                    continue
                if bare in _PARA_CMDS:
                    _, args, j = read_args(s, i, 1, max_opt=1)
                    title = self._conv(args[0]).strip() if args else ""
                    out.append("\n\n" + title + ("" if title.endswith((".", "?", "!", ":")) else ".") + "\n\n")
                    i = j
                    continue
                if bare in ("ensuremath",):
                    _, _, j = read_args(s, i, 1, max_opt=0)
                    out.append(" [math] ")
                    i = j
                    continue
                if bare == "texorpdfstring":
                    _, args, j = read_args(s, i, 2, max_opt=0)
                    out.append(self._conv(args[0]) if args else "")
                    i = j
                    continue
                if bare in NOARG:
                    continue
                if bare in SYMBOLS:
                    if bare == "item":
                        _, _, i = read_args(s, i, 0, max_opt=1)
                    out.append(SYMBOLS[bare])
                    # swallow the "{}" that often follows a symbol macro
                    if s[i:i + 2] == "{}":
                        i += 2
                    continue
                if bare in KEEP1:
                    _, args, j = read_args(s, i, 1, max_opt=1)
                    out.append(self._conv(args[0]) if args else "")
                    i = j
                    continue
                if bare in KEEP_LAST:
                    _, args, j = read_args(s, i, KEEP_LAST[bare], max_opt=3)
                    out.append(self._conv(args[-1]) if args else "")
                    i = j
                    continue
                if bare in DROP_ARGS:
                    k = DROP_ARGS[bare]
                    if bare == "cmidrule" and i < n and s[_skip_ws(s, i)] == "(":
                        e = s.find(")", i)
                        i = e + 1 if e > 0 else i
                    _, _, i = read_args(s, i, k, max_opt=2)
                    continue
                # unknown command: drop optional args, keep the text of its last brace group
                _, args, j = read_args(s, i, 0, max_opt=2, greedy=True)
                if args:
                    out.append(self._conv(args[-1]))
                i = j
                continue
            if c == "$":
                if s.startswith("$$", i):
                    e = s.find("$$", i + 2)
                    i = n if e < 0 else e + 2
                else:
                    k = i + 1
                    while k < n and not (s[k] == "$" and s[k - 1] != "\\"):
                        k += 1
                    i = k + 1
                out.append(" [math] ")
                continue
            if c in "{}":
                i += 1
                continue
            if c == "~":
                out.append(" ")
                i += 1
                continue
            if c == "&":
                out.append(" ")
                i += 1
                continue
            if c == "#":
                i += 1
                continue
            if s.startswith("``", i):
                out.append("“")
                i += 2
                continue
            if s.startswith("''", i):
                out.append("”")
                i += 2
                continue
            if s.startswith("---", i):
                out.append("—")
                i += 3
                continue
            if s.startswith("--", i):
                out.append("–")
                i += 2
                continue
            out.append(c)
            i += 1
        return "".join(out)


# ----------------------------------------------------------------------------- env spans

_BEGIN_END = re.compile(r"\\(begin|end)\s*\{([^}]+)\}")


def env_spans(text: str) -> list[tuple[str, int, int, int]]:
    """(name, begin_start, content_start, end_end) for every balanced environment."""
    stack: list[tuple[str, int, int]] = []
    spans = []
    for m in _BEGIN_END.finditer(text):
        name = m.group(2).strip()
        if m.group(1) == "begin":
            stack.append((name, m.start(), m.end()))
        else:
            for k in range(len(stack) - 1, -1, -1):
                if stack[k][0] == name:
                    nm, b, cs = stack.pop(k)
                    del stack[k:]
                    spans.append((nm, b, cs, m.end()))
                    break
    return spans


# ----------------------------------------------------------------------------- bibliography names

def _bib_names(root: str) -> dict[str, list[str]]:
    """Map citation key -> names by which the work is mentioned in text (title acronym, first author)."""
    names: dict[str, list[str]] = {}
    for dp, _, files in os.walk(root):
        for f in files:
            if not f.endswith((".bib", ".bbl")):
                continue
            try:
                t = _read(os.path.join(dp, f))
            except OSError:
                continue
            if f.endswith(".bib"):
                for m in re.finditer(r"@\w+\s*\{\s*([^,\s]+)\s*,", t):
                    key = m.group(1)
                    nxt = t.find("\n@", m.end())
                    body = t[m.end(): nxt if nxt > 0 else len(t)]
                    tm = re.search(r"\btitle\s*=\s*[{\"](.+?)[}\"]\s*,?\s*\n", body, re.S | re.I)
                    am = re.search(r"\bauthor\s*=\s*[{\"](.+?)[}\"]\s*,?\s*\n", body, re.S | re.I)
                    ns = []
                    if tm:
                        title = re.sub(r"[{}\\]", "", tm.group(1)).strip()
                        head = title.split(":")[0].strip()
                        if ":" in title and 1 <= len(head.split()) <= 3 and re.search(r"[A-Z]", head[1:]):
                            ns.append(head)
                    if am:
                        first = re.split(r"\s+and\s+", am.group(1))[0]
                        sur = first.split(",")[0].strip() if "," in first else first.split()[-1] if first.split() else ""
                        sur = re.sub(r"[{}\\'\"`^~]", "", sur)
                        if len(sur) > 2:
                            ns.append(sur + " et al")
                    if ns:
                        names.setdefault(key, []).extend(ns)
    return names


# ----------------------------------------------------------------------------- reader

_STATEMENT = re.compile(r"(ethic|reproducib|ai use|use of ai|llm use|use of (large )?language model|broader impact|"
                        r"societal impact|author contribution|acknowledg|funding|impact statement|disclosure|"
                        r"checklist|code of conduct)", re.I)
_BODY_CUT = re.compile(r"\\appendix\b|\\begin\{appendices\}|\\bibliography\s*\{|\\printbibliography|"
                       r"\\begin\{thebibliography\}|\\section\*?\s*\{\s*Acknowledg|\\begin\{ack\}|"
                       r"\\section\*?\s*\{\s*(Supplementary|Appendix)", re.I)
_SECTION = re.compile(r"\\section(\*?)\s*(?:\[[^\]]*\])?\s*\{")
_LABEL = re.compile(r"\\label\s*\{([^}]*)\}")
_REF = re.compile(r"\\(" + "|".join(sorted(REF_CMDS, key=len, reverse=True)) + r")\*?\s*\{([^}]*)\}|\\hyperref\s*\[([^\]]*)\]")
_CAPTION = re.compile(r"\\caption(?:of)?\*?\s*(?:\{[^}]*\}\s*)?(?:\[[^\]]*\])?\s*\{")
_INCLUDEGRAPHICS = re.compile(r"\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}")
_PRINTED_SEC = re.compile(r"(?:\bSections?|\bSecs?\.|§)\s*~?\s*(\d+)(?:\.\d+)*")
_PRINTED_FIG = re.compile(r"\b(?:Figures?|Figs?\.)\s*~?\s*(\d+)")
_PRINTED_TAB = re.compile(r"\bTables?\s*~?\s*(\d+)")
_PRINTED_APP = re.compile(r"\bAppendi(?:x|ces)\s*~?\s*([A-Z])\b")
_EXHIBIT_ENV = re.compile(r"^(verbatim|Verbatim|lstlisting|minted|alltt|quote|quotation|lstinputlisting)$|"
                          r"(prompt|example|dialog|transcript|conversation|output|sample|specimen|query|"
                          r"response|chat|casestudy|case)", re.I)
_BOX_ENV = re.compile(r"(tcolorbox|mdframed|framed|fbox|box)", re.I)
_IO_MARKER = re.compile(r"\b(Prompt|Input|Output|Question|Answer|User|Assistant|Response|System|Query|"
                        r"Instruction|Model output|Generated)\s*:", re.I)
EXHIBIT_CAPTION = re.compile(
    r"\b(examples?|exemplars?|case stud(?:y|ies)|failure (?:cases?|modes?|examples?|analysis)|qualitative|"
    r"sample (?:outputs?|generations?|responses?)|generated (?:outputs?|samples?|texts?)|worked example|"
    r"walk-?through|illustrative|specimens?|prompt templates?|prompts? used|(?:system|user|full|exact|example) "
    r"prompts?|transcripts?|(?:model|llm|generated|sample) outputs?|(?:model|generated|example|sample) responses?|"
    r"excerpts?|generations|visuali[sz]ations? of|qualitative results?)\b", re.I)
ACK_GAP = re.compile(
    r"\b(no|not any)\s+(individual|concrete|specific)\s+(cases?|instances?|examples?|failure cases?)\s+"
    r"(were|was|are|is|have been|has been)\s+(retained|inspected|shown|displayed|examined|reported)|"
    r"\brests?\s+(solely\s+|only\s+)?on\s+aggregate|\b(solely|only)\s+on\s+aggregate\s+(scores|results|metrics)|"
    r"\bdoes not (display|show|include|present) (any )?(concrete |individual )+(examples?|instances?|cases?)", re.I)
_INTRO = re.compile(r"intro", re.I)
_RELATED = re.compile(r"(related|prior|previous)\s+(work|research|literature|studies)|background|literature review|"
                      r"related\s+approaches", re.I)
_NUMERIC_CELL = re.compile(r"^[\(\[]?\s*[+\-−±~≈<>]?\s*\d[\d,]*(?:\.\d+)?\s*(?:%|×|x|k|K|M|B|s|ms|h)?\s*"
                           r"(?:[±]\s*\d[\d.]*)?\s*[\)\]]?\s*[*†‡]*$")


def _cell_is_numeric(cell: str) -> bool:
    c = cell.replace("[math]", "").replace("$", "").strip()
    c = re.sub(r"\s+", " ", c)
    return bool(c) and bool(_NUMERIC_CELL.match(c))


def parse_tabular(content: str, conv: Tex2Text) -> tuple[int, int]:
    """(data_rows, numeric_cells) of a tabular body."""
    body = re.sub(r"\\(toprule|midrule|bottomrule|hline|hdashline|addlinespace|endhead|endfirsthead|endfoot|"
                  r"endlastfoot)\b(\[[^\]]*\])?", " ", content)
    body = re.sub(r"\\(cmidrule|cline)\s*(\([^)]*\))?\s*\{[^}]*\}", " ", body)
    body = re.sub(r"\\(rowcolor|cellcolor)\s*(\[[^\]]*\])?\s*\{[^}]*\}", " ", body)
    body = re.sub(r"\\specialrule\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\}", " ", body)
    rows = re.split(r"\\\\(?:\s*\[[^\]]*\])?|\\tabularnewline", body)
    data_rows = numeric = 0
    for r in rows[1:] if len(rows) > 1 else rows:
        cells = re.split(r"(?<!\\)&", r)
        k = 0
        for cell in cells:
            txt = conv(cell)
            if _cell_is_numeric(txt):
                k += 1
        if k:
            data_rows += 1
            numeric += k
    return data_rows, numeric


def _brace_arg(text: str, pos: int) -> tuple[str, int]:
    e = match_group(text, pos)
    return (text[pos + 1:e], e + 1) if e > 0 else ("", pos)


def read_latex(root: str) -> Document:
    main = find_main_tex(root)
    if not main:
        raise ValueError("No main .tex file with \\documentclass and \\begin{document} found in the source.")
    raw = strip_comments(_read(main))
    full = expand_inputs(raw, os.path.dirname(main), os.path.dirname(main))
    macros = Macros()
    full = macros.harvest(full)
    full = macros.expand(full)
    conv = Tex2Text(macros.env_nargs)
    doc = Document(source="latex", workdir=root)

    b = full.find("\\begin{document}")
    preamble, body_all = (full[:b], full[b + len("\\begin{document}"):]) if b >= 0 else ("", full)
    e = body_all.find("\\end{document}")
    if e >= 0:
        body_all = body_all[:e]

    tm = re.search(r"\\(?:title|icmltitle|Title|mytitle|papertitle)\s*(?:\[[^\]]*\])?\s*\{", preamble + body_all)
    if tm:
        src = preamble + body_all
        t, _ = _brace_arg(src, tm.end() - 1)
        doc.title = re.sub(r"\s+", " ", conv(t)).strip()

    # abstract
    am = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", body_all, re.S)
    abstract_tex = am.group(1) if am else ""
    if am:
        body_all = body_all[:am.start()] + body_all[am.end():]

    # body / back matter split
    cm = _BODY_CUT.search(body_all)
    body, back = (body_all[:cm.start()], body_all[cm.start():]) if cm else (body_all, "")
    # everything after the body except the bibliography: appendix, supplementary sections, statements
    appendix = re.sub(r"\\begin\{thebibliography\}.*?\\end\{thebibliography\}", "", back, flags=re.S)
    appendix = re.sub(r"\\(bibliography|bibliographystyle|printbibliography)\s*(\{[^}]*\})?", "", appendix)

    # sections
    heads = list(_SECTION.finditer(body))
    raw_sections: list[tuple[str, bool, str]] = []
    for k, m in enumerate(heads):
        title_tex, end = _brace_arg(body, m.end() - 1)
        stop = heads[k + 1].start() if k + 1 < len(heads) else len(body)
        raw_sections.append((title_tex, m.group(1) == "*", body[end:stop]))
    if heads:
        pre = body[:heads[0].start()]
        pre = re.sub(r"\\maketitle", "", pre)
        if raw_sections and re.search(r"\\begin\{(figure|table)", pre):
            t0, s0, c0 = raw_sections[0]
            raw_sections[0] = (t0, s0, pre + "\n" + c0)
    # starred statement sections belong to the back matter
    kept, moved = [], []
    for title_tex, starred, content in raw_sections:
        title = conv(title_tex).strip()
        if _STATEMENT.search(title):
            moved.append((title, content))
        else:
            kept.append((title, starred, content))
    if moved:
        doc.warnings.append("Excluded statement sections from the body: " + ", ".join(t for t, _ in moved))

    # appendix labels (pointers into the appendix are recorded apart)
    appendix_labels = set(_LABEL.findall(appendix))
    app_letters = {}
    for k, m in enumerate(_SECTION.finditer(appendix)):
        t, end = _brace_arg(appendix, m.end() - 1)
        nxt = appendix.find("\\section", end)
        for lab in _LABEL.findall(appendix[end: nxt if nxt > 0 else len(appendix)]):
            app_letters.setdefault(chr(ord("A") + k), set()).add(lab)

    num = 0
    fig_no = tab_no = 0
    alias: dict[str, str] = {}
    sec_raw: dict[int, str] = {}
    theorem_envs = BASE_THEOREMS | macros.theorems
    for idx, (title, starred, content) in enumerate(kept, 1):
        if not starred:
            num += 1
        sec = Section(idx=idx, title=title, number=None if starred else str(num))
        doc.sections.append(sec)
        sec_raw[idx] = content
        sobj = Obj(id=f"§{idx}", kind="section", home=idx,
                   display=(f"§{sec.number} " if sec.number else "") + title)
        doc.objects.append(sobj)

        spans = env_spans(content)
        # labeled objects
        float_groups: dict[tuple, Obj] = {}
        for lm in _LABEL.finditer(content):
            lab = lm.group(1).strip()
            pos = lm.start()
            encl = [sp for sp in spans if sp[1] < pos < sp[3]]
            encl.sort(key=lambda sp: sp[3] - sp[1])
            kind, span = None, None
            for sp in encl:
                nm = sp[0]
                if nm in MATH_ENVS:
                    kind, span = "equation", (sp[1], pos)   # every equation label is its own object
                    break
                if nm.rstrip("*") in theorem_envs:
                    kind, span = "theorem", (sp[1], sp[3])
                    break
                if nm in FLOAT_KIND:
                    kind, span = FLOAT_KIND[nm], (sp[1], sp[3])
                    break
            if kind is None:
                alias[lab] = sobj.id
                sobj.aliases.append(lab)
                continue
            if kind in ("figure", "table", "algorithm"):
                fl = content[span[0]:span[1]]
                has_sub = re.search(r"\\begin\{sub(figure|table)\}|\\subfloat", fl)
                caps = [m.start() + span[0] for m in _CAPTION.finditer(fl)]
                if has_sub or len(caps) <= 1:
                    gkey = (span[0], 0)
                else:
                    gi = sum(1 for c in caps if c < pos) - 1
                    gkey = (span[0], max(gi, 0))
                if gkey in float_groups:
                    o = float_groups[gkey]
                    o.aliases.append(lab)
                    alias[lab] = o.id
                    continue
                cap = ""
                if has_sub or len(caps) <= 1:
                    # the float's own caption is the last top-level one
                    cms = list(_CAPTION.finditer(fl))
                    if cms:
                        cap, _ = _brace_arg(fl, cms[-1].end() - 1)
                else:
                    cstart = caps[gkey[1]] - span[0]
                    cm2 = _CAPTION.match(fl, cstart)
                    if cm2:
                        cap, _ = _brace_arg(fl, cm2.end() - 1)
                o = Obj(id=lab, kind=kind, home=idx, aliases=[lab], caption=conv(cap))
                float_groups[gkey] = o
            else:
                o = Obj(id=lab, kind=kind, home=idx, aliases=[lab])
            doc.objects.append(o)
            alias[lab] = o.id

        # figures & tables of this section (numbering follows caption order)
        for sp in sorted(spans, key=lambda x: x[1]):
            nm = sp[0]
            if nm not in FLOAT_KIND:
                continue
            fl = content[sp[1]:sp[3]]
            outer = [q for q in spans if q[1] < sp[1] and q[3] > sp[3] and q[0] in FLOAT_KIND]
            if outer:
                continue
            caps = list(_CAPTION.finditer(fl))
            has_sub = re.search(r"\\begin\{sub(figure|table)\}|\\subfloat", fl)
            ncap = 1 if (has_sub and caps) else len(caps)
            labs = _LABEL.findall(fl)
            if FLOAT_KIND[nm] == "figure":
                first_fig = fig_no + 1
                fig_no += max(ncap, 1 if caps else 0)
                imgs = [g.strip() for g in _INCLUDEGRAPHICS.findall(fl)]
                cap = ""
                if caps:
                    cap, _ = _brace_arg(fl, caps[-1].end() - 1)
                label = labs[-1] if labs else f"figure-{first_fig}"
                doc.figures.append(Figure(home=idx, label=label, caption=conv(cap), number=str(first_fig),
                                          images=imgs))
                cap_pos_f = [cm_.start() for cm_ in caps]
                for lab in labs:
                    o = next((x for x in doc.objects if x.id == alias.get(lab)), None)
                    if o and not o.number:
                        if ncap > 1:
                            lp = fl.find("\\label{" + lab + "}")
                            gi = max(sum(1 for c in cap_pos_f if c < lp) - 1, 0)
                        else:
                            gi = 0
                        o.number = str(first_fig + gi)
                        o.display = f"Figure {first_fig + gi}"
            elif FLOAT_KIND[nm] == "table":
                first_no = tab_no + 1
                tab_no += max(ncap, 1 if caps else 0)
                # tabulars inside this float, each tied to the caption group it sits in
                cap_pos = [cm_.start() + sp[1] for cm_ in caps]
                for tsp in spans:
                    if tsp[0] in ("tabular", "tabular*", "tabularx", "tabulary", "longtable") and sp[1] < tsp[1] < sp[3]:
                        if any(q[0] in ("tabular", "tabular*", "tabularx", "tabulary", "longtable")
                               and q[1] < tsp[1] and q[3] > tsp[3] for q in spans):
                            continue
                        inner = content[tsp[2]:tsp[3]]
                        inner = re.sub(r"\\end\{" + re.escape(tsp[0]) + r"\}$", "", inner)
                        _, _, j = read_args(inner, 0, 2 if tsp[0] in ("tabular*", "tabularx", "tabulary") else 1,
                                            max_opt=1)
                        dr, nc = parse_tabular(inner[j:], conv)
                        # caption group: the caption nearest before the tabular (or the first one after it)
                        gi = sum(1 for c in cap_pos if c < tsp[1]) - 1
                        if ncap > 1 and gi < 0:
                            gi = 0
                        gi = max(gi, 0)
                        cap = ""
                        if caps:
                            cap, _ = _brace_arg(fl, caps[min(gi, len(caps) - 1)].end() - 1)
                        g_labs = [l for l in labs if alias.get(l)]
                        glab = None
                        for l in g_labs:
                            lp = content.find("\\label{" + l + "}", sp[1])
                            lg = sum(1 for c in cap_pos if c < lp) - 1
                            if max(lg, 0) == gi:
                                glab = l
                                break
                        doc.tables.append(Table(home=idx, label=glab or (labs[0] if labs else f"table-{first_no}"),
                                                caption=conv(cap)[:200], data_rows=dr, numeric_cells=nc))
                for k2, lab in enumerate(labs):
                    o = next((x for x in doc.objects if x.id == alias.get(lab)), None)
                    if o and not o.number:
                        grp = min(k2, max(ncap - 1, 0)) if ncap > 1 else 0
                        o.number = str(first_no + grp)
                        o.display = f"Table {first_no + grp}"
        for o in doc.objects:
            if o.home == idx and not o.display:
                o.display = {"equation": "Eq.", "algorithm": "Algorithm", "theorem": "Theorem"}.get(o.kind, o.kind) \
                            + f" ({o.id})"

        # prose view
        prose = conv(content)
        sec.sentences = _sentences(prose)

    # abstract
    if abstract_tex:
        doc.abstract = Section(idx=0, title="Abstract", number=None, kind="abstract",
                               sentences=_sentences(conv(abstract_tex)))

    # pointers
    by_number = {("section", s.number): f"§{s.idx}" for s in doc.sections if s.number}
    for o in doc.objects:
        if o.number and o.kind in ("figure", "table"):
            by_number[(o.kind, o.number)] = o.id
    for idx, content in sec_raw.items():
        found: list[tuple[int, str, str, str]] = []
        for m in _REF.finditer(content):
            keys = m.group(2) if m.group(2) is not None else m.group(3)
            for key in (k.strip() for k in (keys or "").split(",")):
                if not key:
                    continue
                if key in alias:
                    found.append((m.start(), alias[key], "ref", key))
                elif key in appendix_labels:
                    found.append((m.start(), "appendix:" + key, "ref", key))
        for rx, kind in ((_PRINTED_SEC, "section"), (_PRINTED_FIG, "figure"), (_PRINTED_TAB, "table")):
            for m in rx.finditer(content):
                tgt = by_number.get((kind, m.group(1)))
                if tgt:
                    found.append((m.start(), tgt, "number", m.group(0)))
        for m in _PRINTED_APP.finditer(content):
            found.append((m.start(), "appendix:" + m.group(1), "number", m.group(0)))
        for s in doc.sections:
            t = s.title.strip()
            if s.idx == idx or len(t) < 6:
                continue
            for m in re.finditer(r"\b(?:the\s+)?[“\"']?" + re.escape(t) + r"[”\"']?\s+section\b", content, re.I):
                found.append((m.start(), f"§{s.idx}", "name", m.group(0)))
        found.sort()
        for pos, tgt, via, key in found:
            ctx = conv(content[max(0, pos - 90): pos + 60]).replace("\n", " ")
            doc.pointers.append(Pointer(src=idx, target=tgt, via=via, pos=pos, context=ctx.strip()))

    # figure image paths
    gpaths = [root]
    for gm in re.finditer(r"\\graphicspath\s*\{((?:\{[^}]*\})+)\}", preamble):
        gpaths += [os.path.join(os.path.dirname(main), p) for p in re.findall(r"\{([^}]*)\}", gm.group(1))]
    base = os.path.dirname(main)
    for f in doc.figures:
        resolved = []
        for g in f.images:
            p = None
            for d in [base] + gpaths:
                p = _resolve(root, d, g, exts=("", ".pdf", ".png", ".jpg", ".jpeg", ".PNG", ".JPG", ".PDF"))
                if p and os.path.splitext(p)[1].lower() in (".pdf", ".png", ".jpg", ".jpeg"):
                    break
                p = None
            if p:
                resolved.append(p)
        f.images = resolved

    # exhibits (body + appendix) and acknowledged gap
    related_titles = {s.idx for s in doc.sections if _RELATED.search(s.title)}
    search_parts = [(s.title, sec_raw[s.idx], s.idx in related_titles) for s in doc.sections]
    if appendix:
        search_parts.append(("Appendix", appendix, False))
    for where, text, is_related in search_parts:
        for sp in env_spans(text):
            nm = sp[0]
            inner = text[sp[2]:sp[3]]
            if nm in FLOAT_KIND or nm in MATH_ENVS:
                continue
            if _EXHIBIT_ENV.search(nm) or (_BOX_ENV.search(nm) and _IO_MARKER.search(inner)):
                snippet = re.sub(r"\s+", " ", conv(inner))[:220]
                doc.exhibits.append(Exhibit(kind="environment", where=where, snippet=f"[{nm}] {snippet}"))
        for cm3 in _CAPTION.finditer(text):
            cap, _ = _brace_arg(text, cm3.end() - 1)
            ct = conv(cap)
            if EXHIBIT_CAPTION.search(ct):
                doc.exhibits.append(Exhibit(kind="caption", where=where, snippet=ct[:220]))
        if not is_related:
            pt = conv(text)
            for qm in re.finditer(r"[“\"]([^”\"]{60,1200})[”\"]", pt):
                if len(qm.group(1).split()) >= 20:
                    doc.exhibits.append(Exhibit(kind="quotation", where=where, snippet=qm.group(1)[:220]))
    body_prose = " ".join(sent.text for s in doc.sections for sent in s.sentences)
    doc.gap_acknowledged = bool(ACK_GAP.search(body_prose))

    # intro / related work
    for s in doc.sections:
        if doc.intro_idx is None and _INTRO.search(s.title):
            doc.intro_idx = s.idx
        if _RELATED.search(s.title) and not _INTRO.search(s.title):
            doc.related_idx.append(s.idx)
    if doc.intro_idx is None and doc.sections:
        doc.intro_idx = doc.sections[0].idx

    doc.stats = {
        "main_file": os.path.relpath(main, root),
        "body_sections": len(doc.sections),
        "objects": len(doc.objects),
        "labels_in_appendix": len(appendix_labels),
        "figures": len(doc.figures),
        "tables": len(doc.tables),
        "body_words": sum(s.n_words for s in doc.sections),
        "has_appendix": bool(appendix.strip()),
    }
    doc.work_names = _bib_names(root)
    return doc


def _sentences(prose: str) -> list[Sentence]:
    out = []
    for s in split_sentences(prose):
        groups = [[k for k in m.group(1).split(",") if k] for m in CITE_MARK.finditer(s)]
        text = CITE_MARK.sub("[cite]", s)
        text = re.sub(r"\s+", " ", text).strip()
        text = re.sub(r"\s+([,.;:])", r"\1", text)
        if len(re.sub(r"\[(cite|math|ref)\]", "", text).strip(" .,;:")) < 2:
            continue
        out.append(Sentence(text=text, cites=groups))
    return out
