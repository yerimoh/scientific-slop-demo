"""Sentence splitting and tokenization shared by both readers and the measures."""
from __future__ import annotations

import re

# Sentinels written by the readers into the prose view.
CITE, MATH, REF = "[cite]", "[math]", "[ref]"
# Citation markers carry their keys until sentences are built: ⟦c:key1,key2⟧
CITE_MARK = re.compile(r"⟦c:([^⟧]*)⟧")

_ABBREV = [
    "e.g.", "i.e.", "et al.", "etc.", "vs.", "cf.", "Fig.", "Figs.", "Eq.", "Eqs.", "Sec.", "Secs.",
    "Tab.", "No.", "approx.", "resp.", "w.r.t.", "Dr.", "Prof.", "Mr.", "Ms.", "St.", "Ref.", "Refs.",
    "App.", "Appx.", "Thm.", "Def.", "Prop.", "Alg.", "Ch.", "pp.", "vol.", "Jan.", "Feb.", "Aug.",
    "Sept.", "Oct.", "Nov.", "Dec.", "Inc.", "Corp.", "Ltd.", "U.S.",
]
_PROTECT = "․"  # one-dot leader, stands in for a protected period


def _protect(text: str) -> str:
    for a in _ABBREV:
        text = re.sub(r"(?<![A-Za-z])" + re.escape(a), a.replace(".", _PROTECT), text)
    # single capital initials ("J. Smith") and decimals
    text = re.sub(r"\b([A-Z])\.(?=\s+[A-Z][a-z])", r"\1" + _PROTECT, text)
    text = re.sub(r"(\d)\.(\d)", r"\1" + _PROTECT + r"\2", text)
    return text


_SPLIT = re.compile(r"(?<=[.!?])[\"'”’)\]]*\s+(?=[\"'“‘(\[⟦]*[A-Z0-9⟦\[])")


def split_sentences(block: str) -> list[str]:
    """Split one paragraph-level block into sentences."""
    out = []
    for para in re.split(r"\n\s*\n", block):
        para = re.sub(r"\s+", " ", para).strip()
        if not para:
            continue
        for s in _SPLIT.split(_protect(para)):
            s = s.replace(_PROTECT, ".").strip()
            if s:
                out.append(s)
    return out


_TOKEN = re.compile(r"\[(?:cite|math|ref)\]|[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*")


def tokenize(text: str) -> list[tuple[str, int, int]]:
    """Lower-cased word tokens with their character spans in `text`."""
    return [(m.group(0).lower(), m.start(), m.end()) for m in _TOKEN.finditer(text)]


def word_count(text: str) -> int:
    return len(_TOKEN.findall(text))


# Relational cues that link one cited work to another. The paper's frozen cue list is not public;
# these lists are our reconstruction (contrast, similarity, lineage, comparison).
RELATION_CUES = re.compile(
    r"\b(unlike|in contrast to|by contrast|contrary to|whereas|similar(ly)? to|likewise|analogous to|"
    r"akin to|compared (to|with)|extends?|extending|builds? (on|upon)|building on|inspired by|"
    r"improves? (on|upon)|generali[sz]es?|complements?|complementary to|instead of|rather than|"
    r"as in|as with|differs? from|departs? from)\b", re.I)
SENTENCE_INITIAL_CUES = re.compile(
    r"^(similarly|likewise|in contrast|by contrast|conversely|alternatively|building on|following|"
    r"extending|in the same vein|along (this|these|the same) lines?|complementary|subsequently|"
    r"more recently|later|concurrently|relatedly|in a similar|a related|another line|other (work|works|studies))\b",
    re.I)
# Plural / deictic mention of works cited elsewhere ("these methods", "prior approaches").
DEICTIC_WORKS = re.compile(
    r"\b(these|those|such|prior|previous|earlier|above|aforementioned|existing|other|both)\s+"
    r"(methods?|works?|approaches|studies|models|systems|techniques|detectors|papers|efforts|lines?|"
    r"frameworks|benchmarks|baselines)\b", re.I)
FIRST_PERSON = re.compile(r"\b(we|our|ours|us|this (paper|work|study|article))\b", re.I)
