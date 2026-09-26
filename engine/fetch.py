"""Turn an upload or a link into something a reader can open: a LaTeX project directory or a PDF.

arXiv links fetch the e-print source first (full structure view), falling back to the PDF.
OpenReview links and direct PDF links fetch the PDF. Archives are extracted without path traversal.
"""
from __future__ import annotations

import gzip
import io
import os
import re
import shutil
import tarfile
import zipfile
from typing import Optional

import httpx

MAX_BYTES = int(os.environ.get("SCISLOP_MAX_UPLOAD_MB", "50")) * 1024 * 1024
UA = {"User-Agent": "Mozilla/5.0 (compatible; ScienceSlopIndex/0.1; +https://example.org)"}
ARXIV = re.compile(r"(?:arxiv\.org/(?:abs|pdf|html|e-print)/|^arxiv:\s*)([a-z\-]+(?:\.[A-Z]{2})?/\d{7}|\d{4}\.\d{4,5})(v\d+)?",
                   re.I)
OPENREVIEW = re.compile(r"openreview\.net/(?:forum|pdf|attachment)\?id=([A-Za-z0-9_\-]+)", re.I)


class InputError(ValueError):
    pass


def _public_host(url: str) -> bool:
    """Refuse links that resolve to loopback / private / link-local addresses (no SSRF from the web form)."""
    import ipaddress
    import socket
    host = httpx.URL(url).host
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


def _kind_of(data: bytes, name: str = "") -> str:
    if data[:4] == b"%PDF":
        return "pdf"
    if data[:2] == b"PK":
        return "zip"
    if data[:2] == b"\x1f\x8b":
        return "gzip"
    if len(data) > 262 and data[257:262] == b"ustar":
        return "tar"
    if name.endswith(".tex") or b"\\documentclass" in data[:20000]:
        return "tex"
    return "unknown"


def _safe_extract_zip(data: bytes, dest: str):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        total = 0
        for info in z.infolist():
            name = info.filename
            if name.startswith("/") or ".." in name.split("/") or info.is_dir():
                continue
            total += info.file_size
            if total > 4 * MAX_BYTES:
                raise InputError("Archive is too large once extracted.")
            target = os.path.join(dest, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def _safe_extract_tar(data: bytes, dest: str):
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        members = []
        for m in t.getmembers():
            if m.name.startswith("/") or ".." in m.name.split("/") or not (m.isfile() or m.isdir()):
                continue
            members.append(m)
        try:
            t.extractall(dest, members=members, filter="data")
        except TypeError:
            t.extractall(dest, members=members)


def _unwrap_single_dir(d: str) -> str:
    entries = [e for e in os.listdir(d) if not e.startswith((".", "__MACOSX"))]
    if len(entries) == 1 and os.path.isdir(os.path.join(d, entries[0])):
        return os.path.join(d, entries[0])
    return d


def _find(d: str, ext: str) -> list[str]:
    out = []
    for dp, _, fs in os.walk(d):
        out += [os.path.join(dp, f) for f in fs if f.lower().endswith(ext)]
    return out


def materialize(data: bytes, name: str, workdir: str) -> tuple[str, str]:
    """Store bytes as a readable input. Returns (kind, path) with kind in {latex, pdf}."""
    kind = _kind_of(data, name.lower())
    src = os.path.join(workdir, "src")
    os.makedirs(src, exist_ok=True)
    if kind == "pdf":
        p = os.path.join(workdir, "paper.pdf")
        with open(p, "wb") as f:
            f.write(data)
        return "pdf", p
    if kind == "gzip":
        raw = gzip.decompress(data)
        k2 = _kind_of(raw, name[:-3] if name.endswith(".gz") else name)
        if k2 == "tar":
            _safe_extract_tar(raw, src)
        elif k2 == "pdf":
            return materialize(raw, "paper.pdf", workdir)
        else:
            with open(os.path.join(src, "main.tex"), "wb") as f:
                f.write(raw)
    elif kind == "tar":
        _safe_extract_tar(data, src)
    elif kind == "zip":
        _safe_extract_zip(data, src)
    elif kind == "tex":
        with open(os.path.join(src, os.path.basename(name) or "main.tex"), "wb") as f:
            f.write(data)
    else:
        raise InputError("Unsupported file. Upload a PDF, a LaTeX .zip / .tar.gz, or a .tex file.")
    root = _unwrap_single_dir(src)
    from .latex import find_main_tex
    if find_main_tex(root):
        return "latex", root
    pdfs = sorted(_find(root, ".pdf"), key=os.path.getsize, reverse=True)
    if pdfs:
        return "pdf", pdfs[0]
    raise InputError("The archive holds no main .tex file (with \\documentclass) and no PDF.")


async def _get(url: str) -> tuple[bytes, str]:
    """GET with redirects followed by hand, so that every hop is checked against private addresses."""
    allow_private = bool(os.environ.get("SCISLOP_ALLOW_PRIVATE_URLS"))
    async with httpx.AsyncClient(timeout=90, follow_redirects=False, headers=UA) as c:
        for _ in range(6):
            if not allow_private and not _public_host(url):
                raise InputError("That link points to a private address.")
            async with c.stream("GET", url) as r:
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    url = str(httpx.URL(url).join(r.headers["location"]))
                    continue
                if r.status_code != 200:
                    raise InputError(f"Could not fetch {url} (HTTP {r.status_code}).")
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    if len(buf) > MAX_BYTES:
                        raise InputError("The file behind the link is too large.")
                return bytes(buf), r.headers.get("content-type", "")
    raise InputError("Too many redirects.")


async def resolve_url(url: str, workdir: str, prefer_source: bool = True) -> tuple[str, str, dict]:
    """Returns (kind, path, meta)."""
    url = url.strip()
    meta: dict = {"url": url}
    m = ARXIV.search(url)
    if m:
        aid = m.group(1) + (m.group(2) or "")
        meta["arxiv"] = aid
        if prefer_source:
            try:
                data, _ = await _get(f"https://arxiv.org/e-print/{aid}")
                kind, path = materialize(data, "eprint", workdir)
                meta["route"] = "arXiv e-print (LaTeX source)" if kind == "latex" else "arXiv PDF"
                return kind, path, meta
            except Exception as e:  # fall back to the PDF
                meta["source_error"] = str(e)[:200]
        data, _ = await _get(f"https://arxiv.org/pdf/{aid}")
        kind, path = materialize(data, "paper.pdf", workdir)
        meta["route"] = "arXiv PDF"
        return kind, path, meta
    m = OPENREVIEW.search(url)
    if m:
        data, _ = await _get(f"https://openreview.net/pdf?id={m.group(1)}")
        meta["route"] = "OpenReview PDF"
        kind, path = materialize(data, "paper.pdf", workdir)
        return kind, path, meta
    if not re.match(r"^https?://", url):
        raise InputError("Paste an arXiv, OpenReview, or direct PDF link.")
    if not _public_host(url) and not os.environ.get("SCISLOP_ALLOW_PRIVATE_URLS"):
        raise InputError("That link points to a private address.")
    data, ctype = await _get(url)
    if data[:4] != b"%PDF" and ("html" in ctype or data.lstrip()[:1] == b"<"):
        html = data[:400000].decode("utf-8", "ignore")
        pm = re.search(r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)', html, re.I) or \
            re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url', html, re.I)
        if not pm:
            raise InputError("That page links to no PDF (no citation_pdf_url). Paste the PDF link instead.")
        data, _ = await _get(httpx.URL(url).join(pm.group(1)).__str__())
    meta["route"] = "PDF link"
    kind, path = materialize(data, "paper.pdf", workdir)
    return kind, path, meta


def guess_title_from_name(name: Optional[str]) -> str:
    if not name:
        return ""
    base = os.path.splitext(os.path.basename(name))[0]
    return re.sub(r"[_\-]+", " ", base).strip()
