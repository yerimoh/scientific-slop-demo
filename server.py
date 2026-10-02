"""Science Slop Index web server.

    uv run uvicorn server:app --port 8811

POST /api/analyze                 multipart: file=<pdf|zip|tar.gz|tex> [gallery=1] | url=<link> | example=<id>
                                  -> {"key": "xxxx-xxxx-xxxx"}  (the report key; also the report URL /r/<key>)
GET  /api/jobs/<key>              progress while running, the full report when done
POST /api/jobs/<key>/figure       {"index": k}  re-score Figure exposition on another figure
GET  /api/jobs/<key>/pdf          the paper with every finding highlighted (+ summary cover page)
GET  /api/jobs/<key>/pages/<n>.jpg  page images for the in-browser paper view
GET  /api/jobs/<key>/thumb.png    first page, for the gallery
GET  /api/jobs/<key>/export.csv   one row per finding
GET  /api/gallery                 reports listed in the public gallery
GET  /api/config                  model, limits, examples
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import re
import secrets
import shutil
import time
import traceback
from collections import OrderedDict, defaultdict, deque
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles


def _load_dotenv(path: str):
    if not os.path.exists(path):
        return
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


HERE = os.path.dirname(os.path.abspath(__file__))
_load_dotenv(os.path.join(HERE, ".env"))

from engine.fetch import InputError, find_paper_pdf, materialize, resolve_url, _get  # noqa: E402
from engine.typeset import compile_latex
from engine.highlight import annotated_pdf, page_image  # noqa: E402
from engine.llm import LLM  # noqa: E402
from engine.pipeline import analyze_document, attach_pdf, document_summary, read_document, rerun_figure  # noqa: E402

DATA = os.environ.get("SCISLOP_DATA", os.path.join(HERE, "data"))
JOBS_DIR = os.path.join(DATA, "jobs")
SEED_DIR = os.path.join(HERE, "seed")          # curated reports shipped with the code (gallery defaults)
os.makedirs(JOBS_DIR, exist_ok=True)
MAX_UPLOAD = int(os.environ.get("SCISLOP_MAX_UPLOAD_MB", "50")) * 1024 * 1024
RATE_PER_HOUR = int(os.environ.get("SCISLOP_RATE_PER_HOUR", "20"))       # analyses per client IP per hour
MAX_CONCURRENT = int(os.environ.get("SCISLOP_MAX_CONCURRENT", "2"))      # analyses running at once
MAX_DOCS = int(os.environ.get("SCISLOP_MAX_DOCS", "24"))                 # parsed papers kept for figure re-scoring
PERSISTENT = os.environ.get("SCISLOP_PERSISTENT", "0") == "1"           # set when DATA sits on a persistent disk

# The bundled example is served only when its source exists on this machine (it is not in the image).
EXAMPLES = {
    "science-or-slop": {
        "title": "Science or Slop? Benchmarking and Mitigating Scientific Slop in AI-Generated Papers",
        "venue": "ICLR 2027 submission · LaTeX source",
        "path": os.environ.get("SCISLOP_EXAMPLE_PATH",
                               os.path.normpath(os.path.join(HERE, "..", "_ICLR_2027__Scientific_Slop"))),
    }
}

app = FastAPI(title="Science Slop Index")
JOBS: dict[str, dict] = {}
DOCS: "OrderedDict[str, object]" = OrderedDict()
RUN_SLOTS = asyncio.Semaphore(MAX_CONCURRENT)
HITS: dict[str, deque] = defaultdict(deque)
_KEY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_KEY_RE = re.compile(r"^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$|^[A-Za-z0-9_-]{8,40}$")


# ----------------------------------------------------------------------------- storage

def _new_key() -> str:
    while True:
        raw = "".join(secrets.choice(_KEY_ALPHABET) for _ in range(12))
        key = f"{raw[:4]}-{raw[4:8]}-{raw[8:]}"
        if not os.path.exists(os.path.join(JOBS_DIR, key)):
            return key


def _norm_key(key: str) -> str:
    k = key.strip().lower().replace(" ", "")
    if re.fullmatch(r"[a-z0-9]{12}", k):
        k = f"{k[:4]}-{k[4:8]}-{k[8:]}"
    return k if _KEY_RE.match(k) else key.strip()


def _job_dir(key: str) -> str:
    if not _KEY_RE.match(key):
        raise HTTPException(404, "Unknown report key")
    return os.path.join(JOBS_DIR, key)


def _find_file(key: str, name: str) -> Optional[str]:
    """A report file: its own folder first, then the shipped seed folder (gallery defaults)."""
    for base in (JOBS_DIR, SEED_DIR):
        p = os.path.join(base, key, "files", name)
        if os.path.exists(p):
            return p
    return None


def _save(job: dict):
    if job.get("seed"):
        return
    d = _job_dir(job["id"])
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "job.json"), "w") as f:
        json.dump({k: v for k, v in job.items() if not k.startswith("_")}, f)


def _load(key: str) -> Optional[dict]:
    key = _norm_key(key)
    if key in JOBS:
        return JOBS[key]
    for base in (JOBS_DIR, SEED_DIR):
        p = os.path.join(base, key, "job.json")
        if _KEY_RE.match(key) and os.path.exists(p):
            with open(p) as f:
                job = json.load(f)
            if base == SEED_DIR:
                job["seed"] = True
            JOBS[key] = job
            return job
    return None


def _index_existing():
    """On start, list finished reports already on disk (and the shipped seeds) for the gallery."""
    for base in (SEED_DIR, JOBS_DIR):
        if not os.path.isdir(base):
            continue
        for k in os.listdir(base):
            if k in JOBS or not _KEY_RE.match(k):
                continue
            p = os.path.join(base, k, "job.json")
            if os.path.exists(p):
                try:
                    with open(p) as f:
                        job = json.load(f)
                except Exception:
                    continue
                if job.get("status") == "done":
                    if base == SEED_DIR:
                        job["seed"] = True
                    JOBS[k] = job


_index_existing()


# ----------------------------------------------------------------------------- limits

def _client_ip(request: Request) -> str:
    ip = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return ip or (request.client.host if request.client else "?")


def _rate_limit(request: Request):
    if RATE_PER_HOUR <= 0:
        return
    ip, now = _client_ip(request), time.time()
    q = HITS[ip]
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= RATE_PER_HOUR:
        raise HTTPException(429, f"This site allows {RATE_PER_HOUR} analyses per hour from one address. Try again later.")
    q.append(now)


def _remember_doc(key: str, doc):
    DOCS[key] = doc
    DOCS.move_to_end(key)
    while len(DOCS) > MAX_DOCS:
        DOCS.popitem(last=False)
    if len(JOBS) > 400:
        for k in sorted(JOBS, key=lambda k: JOBS[k].get("created", 0))[:len(JOBS) - 400]:
            if JOBS[k].get("status") != "running" and not JOBS[k].get("seed"):
                JOBS.pop(k, None)


# ----------------------------------------------------------------------------- analysis

async def _run(job: dict, kind: Optional[str], path: Optional[str], url: Optional[str], meta: dict, api_key: Optional[str] = None):
    key = job["id"]
    workdir = _job_dir(key)

    def progress(pct: float, label: str):
        job["progress"] = {"pct": round(max(job["progress"]["pct"], min(pct, 100)), 1), "label": label}

    try:
        if RUN_SLOTS.locked():
            job["stage"] = "Waiting in line"
            progress(1, "Waiting in line")
        async with RUN_SLOTS:
            if url:
                job["stage"] = "Fetching the paper"
                progress(4, "Fetching the paper")
                kind, path, m2 = await resolve_url(url, workdir)
                meta.update(m2)
            job["stage"] = "Reading the paper"
            progress(12, "Reading the paper")
            doc = await asyncio.to_thread(read_document, kind, path)
            view_pdf = meta.get("view_pdf") or (path if kind == "pdf" else None)
            if not view_pdf and kind == "latex":
                view_pdf = await asyncio.to_thread(find_paper_pdf, path, doc.title)
            if not view_pdf and kind == "latex":
                # no compiled PDF came with the source: typeset it here so the findings can be shown on the paper
                job["stage"] = "Typesetting the paper"
                progress(16, "Typesetting the paper (LaTeX → PDF)")
                notes: list[str] = []
                view_pdf = await asyncio.to_thread(compile_latex, path, 300, notes.append)
                if view_pdf:
                    meta["route"] = (meta.get("route") or "LaTeX source") + " · typeset here"
                elif notes:
                    print("typeset failed:", notes[-1][-300:])
            if not doc.title and view_pdf:
                doc.title = await asyncio.to_thread(_pdf_title, view_pdf)
            job["document"] = document_summary(doc, meta)
            job["stage"] = "Measuring"
            llm = LLM(api_key=api_key or None)   # the visitor's own key; never stored with the report

            async def emit(ev: str, payload: dict):
                if ev == "measure":
                    job["measures"][payload["key"]] = payload
                    job["running"] = [k for k in job["running"] if k != payload["key"]]
                elif ev == "running":
                    job["running"].append(payload["key"])

            result = await analyze_document(doc, llm, os.path.join(workdir, "files"), emit=emit, meta=meta,
                                            view_pdf=view_pdf, progress=progress)
            result["key"] = key
            result["gallery"] = job.get("gallery", False)
            result["pdf_source"] = meta.get("url")
            _remember_doc(key, doc)
            job["result"] = result
            job["title"] = result["document"]["title"]
            job["status"] = "done"
            job["stage"] = "Done"
    except InputError as e:
        job["status"], job["error"] = "error", str(e)
    except Exception as e:
        traceback.print_exc()
        job["status"], job["error"] = "error", f"Could not analyze this paper: {type(e).__name__}: {e}"
    finally:
        # sources are deleted once the report exists; the report keeps its PDF copy in files/
        shutil.rmtree(os.path.join(workdir, "src"), ignore_errors=True)
        for leftover in ("paper.pdf", "view.pdf"):
            try:
                os.remove(os.path.join(workdir, leftover))
            except OSError:
                pass
    job["finished"] = time.time()
    _save(job)


def _pdf_title(path: str) -> str:
    """Title of a paper from its PDF: document metadata, else the largest text on page one."""
    try:
        import pymupdf
        with pymupdf.open(path) as d:
            t = (d.metadata or {}).get("title") or ""
            if len(t.split()) >= 3 and not re.search(r"\.(tex|dvi|pdf)$|^untitled|^microsoft word", t, re.I):
                return t.strip()
        from engine.pdf import read_pdf
        return read_pdf(path).title
    except Exception:
        return ""


def _new_job(label: str, gallery: bool) -> dict:
    key = _new_key()
    job = {"id": key, "key": key, "status": "running", "stage": "Queued", "label": label, "created": time.time(),
           "gallery": gallery, "progress": {"pct": 0, "label": "Queued"},
           "measures": {}, "running": [], "document": None, "result": None, "error": None}
    JOBS[key] = job
    os.makedirs(_job_dir(key), exist_ok=True)
    return job


@app.post("/api/analyze")
async def analyze(request: Request, file: Optional[UploadFile] = File(None), url: Optional[str] = Form(None),
                  example: Optional[str] = Form(None), gallery: Optional[str] = Form(None),
                  api_key: Optional[str] = Form(None)):
    meta: dict = {}
    api_key = (api_key or "").strip()[:200] or None
    if not example:
        _rate_limit(request)
    if example:
        ex = EXAMPLES.get(example)
        if not ex or not os.path.isdir(ex["path"]):
            raise HTTPException(404, "Example not available on this server.")
        job = _new_job(ex["title"], gallery=False)
        meta.update({"route": ex["venue"], "fallback_title": ex["title"]})
        asyncio.create_task(_run(job, "latex", ex["path"], None, meta, api_key))
        return {"id": job["id"], "key": job["id"]}
    if file is not None and file.filename:
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"File is larger than {MAX_UPLOAD // (1024 * 1024)} MB.")
        if not data:
            raise HTTPException(400, "The file is empty.")
        job = _new_job(file.filename, gallery=gallery in ("1", "true", "on"))
        try:
            kind, path = materialize(data, file.filename, _job_dir(job["id"]))
        except InputError as e:
            JOBS.pop(job["id"], None)
            raise HTTPException(400, str(e))
        except Exception as e:
            JOBS.pop(job["id"], None)
            raise HTTPException(400, f"Could not open the file: {e}")
        meta.update({"route": "Uploaded " + ("LaTeX source" if kind == "latex" else "PDF"),
                     "fallback_title": os.path.splitext(file.filename)[0]})
        if kind == "pdf":
            meta["view_pdf"] = path
        await _log_submission("analysis", {"id": job["id"], "input": file.filename, "listed": job["gallery"]})
        asyncio.create_task(_run(job, kind, path, None, meta, api_key))
        return {"id": job["id"], "key": job["id"]}
    if url and url.strip():
        job = _new_job(url.strip(), gallery=gallery in ("1", "true", "on"))   # listed only when the submitter opts in
        await _log_submission("analysis", {"id": job["id"], "input": url.strip(), "listed": job["gallery"]})
        asyncio.create_task(_run(job, None, None, url.strip(), meta, api_key))
        return {"id": job["id"], "key": job["id"]}
    raise HTTPException(400, "Give a link or a file.")


def _get_job(key: str) -> dict:
    job = _load(key)
    if not job:
        raise HTTPException(404, "No report with this key. Reports on this server are kept until it restarts.")
    return job


@app.get("/api/jobs/{key}")
async def job_status(key: str):
    job = _get_job(key)
    return JSONResponse({k: v for k, v in job.items() if not k.startswith("_")})


@app.post("/api/jobs/{key}/list")
async def job_list(key: str, body: dict):
    """Whoever holds the key decides whether the report is public. Shipped seeds cannot be changed."""
    job = _get_job(key)
    if job.get("seed"):
        raise HTTPException(403, "Bundled reports are always listed.")
    listed = bool(body.get("listed"))
    job["gallery"] = listed
    if job.get("result"):
        job["result"]["gallery"] = listed
    _save(job)
    await _log_submission("listing", {"id": job["id"], "listed": listed, "title": job.get("title") or job.get("label")})
    return {"id": job["id"], "listed": listed}


@app.post("/api/jobs/{key}/figure")
async def job_figure(key: str, body: dict):
    job = _get_job(key)
    key = job["id"]
    doc = DOCS.get(key)
    if not job.get("result"):
        raise HTTPException(404, "Unknown report")
    if doc is None:
        raise HTTPException(409, "This report was restored from storage; analyze the paper again to switch figures.")
    idx = int(body.get("index", -1))
    api_key = (str(body.get("api_key") or "")).strip()[:200] or None
    result = await rerun_figure(doc, job["result"], LLM(api_key=api_key), os.path.join(_job_dir(key), "files"), idx)
    job["result"] = result
    _save(job)
    return JSONResponse(result)


async def _ensure_pdf(job: dict) -> Optional[str]:
    """The paper's PDF for a report. Gallery seeds ship without it and fetch it from their public link."""
    key = job["id"]
    have = _find_file(key, "paper.pdf")
    if have:
        try:
            with open(have, "rb") as f:
                if f.read(4) == b"%PDF":
                    return have
        except OSError:
            pass
        try:
            os.remove(have)          # empty or corrupt copy (interrupted download): fetch again
        except OSError:
            pass
    own = os.path.join(_job_dir(key), "files", "paper.pdf")
    src = (job.get("result") or {}).get("pdf_source") or ((job.get("result") or {}).get("document") or {}).get("url")
    if not src:
        return None
    m = re.search(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+?)(?:\.pdf)?$", src)
    pdf_url = f"https://arxiv.org/pdf/{m.group(1)}" if m else src
    try:
        data, _ = await _get(pdf_url)
    except Exception:
        return None
    if data[:4] != b"%PDF":
        return None
    os.makedirs(os.path.dirname(own), exist_ok=True)
    with open(own, "wb") as f:
        f.write(data)
    return own


def _safe_name(title: str) -> str:
    t = re.sub(r"[^A-Za-z0-9]+", "-", title or "paper").strip("-")[:60]
    return t or "paper"


@app.get("/api/jobs/{key}/pdf")
async def job_pdf(key: str):
    job = _get_job(key)
    res = job.get("result") or {}
    if not (res.get("pdf") or {}).get("available"):
        raise HTTPException(404, "No PDF for this report.")
    out = _find_file(job["id"], "highlighted.pdf")
    if not out:
        src = await _ensure_pdf(job)
        if not src:
            raise HTTPException(404, "The paper's PDF is no longer available.")
        data = await asyncio.to_thread(annotated_pdf, src, res)
        out = os.path.join(_job_dir(job["id"]), "files", "highlighted.pdf")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as f:
            f.write(data)
    name = f"{_safe_name(res.get('document', {}).get('title', ''))}.slop-highlighted.pdf"
    return FileResponse(out, media_type="application/pdf", filename=name)


@app.get("/api/jobs/{key}/pages/{n}.jpg")
async def job_page(key: str, n: int):
    job = _get_job(key)
    res = job.get("result") or {}
    pages = (res.get("pdf") or {}).get("pages", 0)
    if not (0 <= n < pages):
        raise HTTPException(404)
    shipped = _find_file(job["id"], f"page_{n}.jpg")          # seeds ship their first page
    if shipped:
        return FileResponse(shipped, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})
    cache = os.path.join(_job_dir(job["id"]), "files", f"page_{n}.jpg")
    if not os.path.exists(cache):
        src = await _ensure_pdf(job)
        if not src:
            raise HTTPException(404, "The paper's PDF is no longer available.")
        img = await asyncio.to_thread(page_image, src, n)
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "wb") as f:
            f.write(img)
    return FileResponse(cache, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


def _layout_nodes(pdf_path: str, res: dict) -> dict:
    """Positions of every section heading and referable object on the PDF, for the reference spine."""
    from engine.pdf import read_pdf
    pdf_doc = read_pdf(pdf_path)
    objs = list(pdf_doc.objects)
    def norm(t): return re.sub(r"[^a-z0-9]", "", (t or "").lower())
    def find(kind: str, number: Optional[str], title: str):
        for o in objs:
            if o.kind == kind and o.loc and number and o.number == number:
                return o.loc
        if title:
            t = norm(title)
            for o in objs:
                if o.kind == kind and o.loc and norm(re.sub(r"^§\S*\s*", "", o.display or "")) == t:
                    return o.loc
        return None
    nodes = []
    m = next((x for x in res.get("measures", []) if x["key"] == "cross_refs"), None)
    outline = (res.get("document") or {}).get("outline") or []
    seen = set()
    for sec in outline:
        if sec.get("idx") is None or sec.get("kind") not in (None, "body"):
            continue
        loc = find("section", sec.get("number"), sec.get("title") or "")
        if loc:
            p_, x0, y0, x1, y1 = loc
            nodes.append({"id": f"§{sec.get('number') or sec['idx']}", "kind": "section", "sec": sec["idx"], "label": (("§" + sec["number"] + " ") if sec.get("number") else "") + (sec.get("title") or ""), "p": p_, "y": round(y0, 1), "y1": round(y1, 1), "x0": round(x0, 1)})
            seen.add(sec["idx"])
    if m:
        KIND = {"figure": "figure", "table": "table", "equation": "equation", "algorithm": "algorithm"}
        for o in (m.get("details") or {}).get("objects", []):
            if o.get("kind") == "section":
                continue
            lab = o.get("label") or ""
            mm = re.match(r"^(Figure|Fig\.?|Table|Tab\.?|Eq\.?|Equation|Algorithm|Alg\.?)\s*\(?([A-Za-z0-9.]+)\)?", lab)
            kind = KIND.get(o.get("kind"), o.get("kind")); number = mm.group(2) if mm else None
            loc = find(kind, number, "")
            if loc:
                p_, x0, y0, x1, y1 = loc
                nodes.append({"id": o["id"], "kind": kind, "home": o.get("home"), "from": o.get("from", []), "own": o.get("own", 0), "label": lab, "p": p_, "y": round(y0, 1), "y1": round(y1, 1), "x0": round(x0, 1)})
    return {"nodes": nodes, "edges": (m.get("details") or {}).get("edges", []) if m else []}


@app.get("/api/jobs/{key}/layout")
async def job_layout(key: str):
    job = _get_job(key)
    res = job.get("result") or {}
    if not (res.get("pdf") or {}).get("available"):
        raise HTTPException(404, "No PDF for this report.")
    cache = os.path.join(_job_dir(job["id"]), "files", "layout.json")
    shipped = _find_file(job["id"], "layout.json")
    if shipped:
        return FileResponse(shipped, media_type="application/json")
    src = await _ensure_pdf(job)
    if not src:
        raise HTTPException(404, "The paper's PDF is no longer available.")
    out = await asyncio.to_thread(_layout_nodes, src, res)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w") as f:
        json.dump(out, f)
    return JSONResponse(out)


def _page_words(pdf_path: str, n: int) -> dict:
    """Word boxes of one page in reading order, for text-snapped flags."""
    import pymupdf
    with pymupdf.open(pdf_path) as pdf:
        page = pdf[n]
        ws = [[round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1), w, b, ln] for x0, y0, x1, y1, w, b, ln, _ in page.get_text("words")]
    ws.sort(key=lambda w: (w[5], w[6], w[0]))
    return {"p": n, "w": [w[:5] for w in ws]}


@app.get("/api/jobs/{key}/words/{n}")
async def job_words(key: str, n: int):
    job = _get_job(key)
    res = job.get("result") or {}
    pages = (res.get("pdf") or {}).get("pages", 0)
    if not (0 <= n < pages):
        raise HTTPException(404)
    shipped = _find_file(job["id"], f"words_{n}.json")
    if shipped:
        return FileResponse(shipped, media_type="application/json")
    src = await _ensure_pdf(job)
    if not src:
        raise HTTPException(404, "The paper's PDF is no longer available.")
    try:
        out = await asyncio.to_thread(_page_words, src, n)
    except Exception as e:  # noqa: BLE001  (a bad PDF should not break flagging: the reader falls back to boxes)
        print("page words failed:", e)
        return JSONResponse({"p": n, "w": []})
    cache = os.path.join(_job_dir(job["id"]), "files", f"words_{n}.json")
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w") as f:
        json.dump(out, f)
    return JSONResponse(out)


@app.get("/api/jobs/{key}/thumb.png")
async def job_thumb(key: str):
    job = _get_job(key)
    p = _find_file(job["id"], "thumb.png")
    if not p:
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/jobs/{key}/export.csv")
async def job_csv(key: str):
    job = _get_job(key)
    res = job.get("result") or {}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["measure", "plane", "measure_score", "section", "pdf_pages", "finding", "detail"])
    for m in res.get("measures", []):
        sc = "" if m.get("score") is None else round(m["score"], 4)
        if not m.get("instances"):
            w.writerow([m["name"], m["plane"], sc, "", "", "", "; ".join(m.get("notes", []))])
        for it in m.get("instances", []):
            pages = sorted({l["p"] + 1 for l in it.get("pdf", [])})
            detail = it.get("why") or (f"{round(100 * it['coverage'])}% copied from {it.get('source_title')}"
                                       if "coverage" in it else it.get("caption", ""))
            w.writerow([m["name"], m["plane"], sc, it.get("section_title", ""), " ".join(map(str, pages)),
                        it.get("text", ""), detail])
    name = f"{_safe_name(res.get('document', {}).get('title', ''))}.slop-report.csv"
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/jobs/{key}/files/{name}")
async def job_file(key: str, name: str):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.png", name):
        raise HTTPException(404)
    job = _get_job(key)
    p = _find_file(job["id"], name)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png")


def _source_label(doc: dict) -> str:
    """Short label for where a paper came from, shown under its bar on the leaderboard."""
    url = (doc.get("url") or "").lower()
    route = (doc.get("route") or "").lower()
    if "arxiv" in url or "arxiv" in route:
        return "arXiv"
    if "openreview" in url:
        return "OpenReview"
    if "aclanthology" in url:
        return "ACL"
    if url:
        host = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
        return host.split(".")[-2].capitalize() if host.count(".") else "Link"
    return "Upload" if "upload" in route else "Example"


def _first_page_marks(res: dict, limit: int = 40) -> list:
    """Finding locations on the first page, drawn over the thumbnail in the gallery."""
    out = []
    for m in res.get("measures", []):
        for it in m.get("instances") or []:
            for loc in it.get("pdf") or []:
                if loc.get("p") != 0:
                    continue
                why = it.get("why") or (f"{round(100 * it['coverage'])}% copied from {it.get('source_title', 'an earlier section')}" if it.get("coverage") is not None else "") or it.get("text") or it.get("caption") or ""
                for r in loc.get("r") or []:
                    out.append({"m": m["key"], "plane": m.get("plane"), "r": [round(v, 1) for v in r], "box": bool(loc.get("box")),
                                "name": m.get("name"), "t": why[:180] + ("…" if len(why) > 180 else "")})
                    if len(out) >= limit:
                        return out
    return out


@app.get("/api/gallery")
async def gallery():
    items = []
    for key, job in list(JOBS.items()):
        res = job.get("result") or {}
        if job.get("status") != "done" or not job.get("gallery") or not res:
            continue
        idx = res.get("index") or {}
        doc = res.get("document") or {}
        items.append({
            "key": key, "title": doc.get("title") or job.get("label"), "index": idx.get("index"),
            "partial": idx.get("partial", False),
            "planes": {k: (v or {}).get("score") for k, v in (idx.get("planes") or {}).items()},
            "route": doc.get("route"), "url": doc.get("url"), "created": job.get("created"),
            "thumb": bool(_find_file(key, "thumb.png")), "seed": bool(job.get("seed")),
            "source": job.get("source_label") or _source_label(doc), "source_kind": doc.get("source"),
            "ai_generated": bool(job.get("ai_generated")), "origin": job.get("origin"),
            "measures": {m["key"]: (m.get("score") if m.get("status") == "done" else None)
                         for m in res.get("measures", [])},
            "page0": ((res.get("pdf") or {}).get("sizes") or [None])[0],
            "marks": _first_page_marks(res),
        })
    # one card per paper: the newest analysis wins (same arXiv id, link, or title)
    def ident(x):
        t = re.sub(r"[^a-z0-9]", "", (x.get("title") or "").lower())[:80]
        if len(t) >= 12:
            return "t:" + t
        m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", x.get("url") or "")
        return "arxiv:" + m.group(1) if m else "k:" + x["key"]
    newest: dict[str, dict] = {}
    for x in sorted(items, key=lambda x: x.get("created") or 0):
        newest[ident(x)] = x
    return {"items": list(newest.values()), "persistent": PERSISTENT}


# ---------------------------------------------------------------- submissions log (Google Sheets webhook)
SHEETS_WEBHOOK = os.environ.get("SCISLOP_SHEETS_WEBHOOK", "")      # Apps Script web app URL; see README
SUBMISSIONS_LOG = os.path.join(DATA, "submissions.jsonl")
CONTRIBUTORS_FILE = os.path.join(DATA, "contributors.json")


async def _log_submission(kind: str, row: dict):
    """Append every submission (analysis, proposal, feedback) to a local log and, when configured, a Google Sheet."""
    rec = {"kind": kind, "at": time.strftime("%Y-%m-%d %H:%M:%S"), **row}
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(SUBMISSIONS_LOG, "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:  # noqa: BLE001
        print("submission log failed:", e)
    if SHEETS_WEBHOOK:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as c:
                await c.post(SHEETS_WEBHOOK, json=rec)
        except Exception as e:  # noqa: BLE001
            print("sheets webhook failed:", e)


def _add_contributor(name: str, kind: str):
    name = (name or "").strip()[:80]
    if not name:
        return
    try:
        data = json.load(open(CONTRIBUTORS_FILE)) if os.path.exists(CONTRIBUTORS_FILE) else []
    except Exception:  # noqa: BLE001
        data = []
    hit = next((c for c in data if c["name"].lower() == name.lower()), None)
    if hit:
        hit["n"] = hit.get("n", 0) + 1; hit.setdefault("kinds", []); hit["kinds"] = sorted(set(hit["kinds"] + [kind]))
    else:
        data.append({"name": name, "n": 1, "kinds": [kind], "since": time.strftime("%Y-%m-%d")})
    os.makedirs(DATA, exist_ok=True)
    with open(CONTRIBUTORS_FILE, "w") as f:
        json.dump(data, f, ensure_ascii=False)


@app.get("/api/contributors")
async def contributors():
    """Everyone who contributed: curated list shipped with the site, plus people who flagged slop or proposed patterns."""
    out: dict[str, dict] = {}
    cur = os.path.join(HERE, "static", "contributors.json")
    for src in (cur, CONTRIBUTORS_FILE):
        if os.path.exists(src):
            try:
                for c in json.load(open(src)):
                    k = c["name"].lower()
                    if k in out:
                        out[k]["n"] = out[k].get("n", 0) + c.get("n", 1); out[k]["kinds"] = sorted(set(out[k].get("kinds", []) + c.get("kinds", [])))
                    else:
                        out[k] = {"name": c["name"], "n": c.get("n", 1), "kinds": c.get("kinds", []), "affiliation": c.get("affiliation", ""), "url": c.get("url", "")}
            except Exception:  # noqa: BLE001
                continue
    for pr in await asyncio.to_thread(_github_proposals):
        nm = (pr.get("author") or "").split(" (")[0].strip()
        if nm and nm.lower() != "anonymous":
            k = nm.lower()
            if k in out:
                out[k]["kinds"] = sorted(set(out[k].get("kinds", []) + ["pattern"]))
            else:
                out[k] = {"name": nm, "n": 1, "kinds": ["pattern"], "affiliation": "", "url": pr.get("url", "")}
    items = sorted(out.values(), key=lambda c: (-c.get("n", 0), c["name"].lower()))
    return {"items": items, "count": len(items)}


FEEDBACK_DIR = os.path.join(DATA, "feedback")


def _render_piece(page, pc: dict) -> Optional[bytes]:
    """One flagged region plus a little context, rendered at up to 2x with the marked rects tinted."""
    import pymupdf
    x0, y0, x1, y1 = pc["r"]
    pad = 10 if pc.get("mode") == "text" else 6
    clip = pymupdf.Rect(max(0, x0 - pad), max(0, y0 - pad), min(page.rect.width, x1 + pad), min(page.rect.height, y1 + pad)) & page.rect
    if clip.is_empty:
        return None
    z = min(2.0, 1400 / max(clip.width, 1))
    annots = []
    for rr in (pc.get("rects") or [pc["r"]]):
        an = page.add_rect_annot(pymupdf.Rect(*rr)); an.set_colors(stroke=(0.66, 0.2, 0.24), fill=(0.66, 0.2, 0.24)); an.set_border(width=0.6); an.set_opacity(0.22); an.update()
        annots.append(an)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(z, z), clip=clip, alpha=False)
    for an in annots:
        page.delete_annot(an)
    return pix.tobytes("jpeg", jpg_quality=80)


def _snap_piece(pdf_path: str, pc: dict) -> Optional[bytes]:
    import pymupdf
    with pymupdf.open(pdf_path) as pdf:
        if not (0 <= pc["p"] < len(pdf)):
            return None
        return _render_piece(pdf[pc["p"]], pc)


def _crop_pieces(pdf_path: str, ann: list, out_dir: str) -> list:
    """Snapshot every marked piece: the region plus a little context, rendered from the PDF at 2x. Returns file names."""
    import pymupdf
    os.makedirs(out_dir, exist_ok=True)
    names = []
    with pymupdf.open(pdf_path) as pdf:
        for i, a in enumerate(ann):
            for j, pc in enumerate(a["pieces"]):
                try:
                    data = _render_piece(pdf[pc["p"]], pc)
                    if not data:
                        continue
                    name = f"s{i + 1}_p{j + 1}.jpg"
                    with open(os.path.join(out_dir, name), "wb") as f:
                        f.write(data)
                    pc["image"] = name
                    names.append((name, data))
                except Exception as e:  # noqa: BLE001
                    print("crop failed:", e)
    return names


@app.get("/api/snap/{key}/{n}/{rect}.jpg")
async def snapshot_image(key: str, n: int, rect: str, m: str = "box", r: str = ""):
    """A picture of one flagged region, rendered from the report's PDF on request (nothing stored):
    rect = x0,y0,x1,y1 in PDF points; r = extra tinted rects "x0,y0,x1,y1;..." (text selections); m = box|text."""
    job = _get_job(key)
    try:
        box = [float(v) for v in rect.split(",")]
        extra = [[float(v) for v in q.split(",")] for q in r.split(";") if q]
        assert len(box) == 4 and all(len(q) == 4 for q in extra)
    except (ValueError, AssertionError):
        raise HTTPException(400, "rect must be x0,y0,x1,y1")
    src = await _ensure_pdf(job)
    if not src:
        raise HTTPException(404, "The paper's PDF is no longer available.")
    piece = {"p": n, "r": box, "rects": extra or [box], "mode": "text" if m == "text" else "box"}
    data = await asyncio.to_thread(_snap_piece, src, piece)
    if not data:
        raise HTTPException(404, "Nothing to render there.")
    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


def _snap_url(base: str, key: str, pc: dict) -> str:
    rect = ",".join(f"{v:g}" for v in pc["r"])
    extra = ";".join(",".join(f"{v:g}" for v in rr) for rr in (pc.get("rects") or []) if rr != list(pc["r"]))
    return f"{base}/api/snap/{key}/{pc['p']}/{rect}.jpg?m={pc.get('mode') or 'box'}" + (f"&r={extra}" if extra else "")


@app.get("/api/feedback/{fid}/{name}")
async def feedback_image(fid: str, name: str):
    if not _KEY_RE.match(fid) or not re.match(r"^s\d+_p\d+\.jpg$", name):
        raise HTTPException(404)
    p = os.path.join(FEEDBACK_DIR, fid, name)
    if not os.path.exists(p):
        raise HTTPException(404, "Snapshot not on this server any more.")
    return FileResponse(p, media_type="image/jpeg")


@app.post("/api/jobs/{key}/feedback")
async def job_feedback(key: str, request: Request, body: dict):
    """Reader flags on a report: regions the reader marked as slop, and findings the reader disputes."""
    _rate_limit(request)
    job = _get_job(key)
    def _piece(pc):
        rects = [[round(float(v), 1) for v in rr[:4]] for rr in (pc.get("rects") or [])[:60]]
        r = [round(float(v), 1) for v in (pc.get("r") or [0, 0, 0, 0])[:4]]
        if rects and r == [0, 0, 0, 0]:   # no union given: take the bounds of the rects
            r = [min(q[0] for q in rects), min(q[1] for q in rects), max(q[2] for q in rects), max(q[3] for q in rects)]
        return {"p": int(pc.get("p", 0)), "r": r, "rects": rects, "mode": str(pc.get("mode") or "box")[:8], "text": str(pc.get("text") or "")[:1000]}
    ann = [{"kind": str(a.get("kind") or "other")[:40], "title": str(a.get("title") or "")[:80].strip(), "note": str(a.get("note") or "")[:600],
            "pattern_name": str(a.get("pattern_name") or "")[:80].strip(), "pattern_what": str(a.get("pattern_what") or "")[:300].strip(),
            "pieces": [_piece(pc) for pc in (a.get("pieces") or ([a] if a.get("r") else []))[:40]]}
           for a in (body.get("annotations") or [])[:100]]
    ann = [a for a in ann if a["pieces"]]
    if any(not a["title"] or len(a["note"]) < 10 for a in ann):
        raise HTTPException(400, "Every slop needs a name and a description.")
    if not str(body.get("name") or "").strip() or not str(body.get("affiliation") or "").strip():
        raise HTTPException(400, "Add your name and affiliation: contributions are credited.")
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(body.get("email") or "").strip()):
        raise HTTPException(400, "Add a valid email so we can reach you about co-authorship.")
    disputed = [({"id": str(d.get("id"))[:60], "kind": str(d.get("kind") or "")[:40]} if isinstance(d, dict) else {"id": str(d)[:60], "kind": ""})
                for d in (body.get("disputed") or [])[:200]]
    if not ann and not disputed:
        raise HTTPException(400, "Nothing to submit: mark at least one region or dispute one finding.")
    fb = {"id": _new_key(), "key": job["id"], "title": (job.get("result") or {}).get("document", {}).get("title") or job.get("title"),
          "annotations": ann, "disputed": disputed, "name": str(body.get("name") or "")[:80].strip(), "affiliation": str(body.get("affiliation") or "")[:120].strip(),
          "email": str(body.get("email") or "")[:120].strip(), "created": time.time()}
    os.makedirs(FEEDBACK_DIR, exist_ok=True)
    images = []
    src = await _ensure_pdf(job)
    if src and ann:
        images = await asyncio.to_thread(_crop_pieces, src, ann, os.path.join(FEEDBACK_DIR, fb["id"]))
    with open(os.path.join(FEEDBACK_DIR, f"{fb['id']}.json"), "w") as f:
        json.dump(fb, f, ensure_ascii=False)
    if fb["name"]:
        _add_contributor(fb["name"], "flags")
    # flags of a kind the index does not know yet are proposals: file each named pattern for review
    proposal_urls = []
    paper_url = ((job.get("result") or {}).get("document") or {}).get("url") or ""
    for a in ann:
        if a["kind"] != "other" or not a["pattern_name"]:
            continue
        quote = " / ".join(pc["text"] for pc in a["pieces"] if pc.get("text"))[:600] or f"{len(a['pieces'])} region(s) marked on the paper"
        pr = {k: "" for k in PROPOSAL_FIELDS}
        pr.update({"name": a["pattern_name"], "plane": "other", "what": a["pattern_what"] or a["note"] or a["pattern_name"], "example_url": paper_url or f"report {job['id']}",
                   "example_quote": (a["note"] + " — " if a["note"] and a["pattern_what"] else "") + quote, "author": fb["name"], "affiliation": fb["affiliation"], "email": fb["email"],
                   "credit_site": True, "credit_paper": True, "id": _new_key(), "created": time.time(), "from_feedback": fb["id"]})
        os.makedirs(PROPOSALS_DIR, exist_ok=True)
        pr["issue_url"] = await asyncio.to_thread(_github_issue, pr)
        with open(os.path.join(PROPOSALS_DIR, pr["id"] + ".json"), "w") as f:
            json.dump(pr, f)
        _PROPOSAL_CACHE["at"] = 0.0
        if fb["name"]:
            _add_contributor(fb["name"], "pattern")
        await _log_submission("proposal", {"id": pr["id"], **{k: pr[k] for k in PROPOSAL_FIELDS}, "issue_url": pr["issue_url"] or "", "from_feedback": fb["id"]})
        proposal_urls.append(pr["issue_url"] or "")
    import base64
    base = str(request.base_url).rstrip("/")
    # pictures of the flagged regions: committed to the snapshot repo when configured (durable), else served from here
    pushed = await asyncio.to_thread(_push_snapshots, fb["id"], images) if images else []
    urls = pushed or [_snap_url(base, job["id"], pc) for a in ann for pc in a["pieces"]]
    await _log_submission("feedback", {"id": fb["id"], "report": fb["key"], "title": fb["title"], "flags": len(ann), "disputed": len(disputed),
                                       "name": fb["name"], "affiliation": fb["affiliation"], "email": fb["email"],
                                       "slops": " | ".join(f"{a['title']} [{a['kind']}]: {a['note']}" for a in ann)[:5000],
                                       "quotes": " | ".join(pc["text"] for a in ann for pc in a["pieces"] if pc.get("text"))[:5000],
                                       "annotations": json.dumps(ann, ensure_ascii=False)[:20000], "disputed_ids": json.dumps(disputed, ensure_ascii=False)[:5000],
                                       "snapshot_urls": " ".join(urls), "preview": f'=IMAGE("{urls[0]}")' if urls else "",
                                       "snapshot_store": "github" if pushed else ("server" if urls else "")})
    if images and SHEETS_WEBHOOK and not pushed:
        # no durable store: hand the pictures to the sheet script (its saveSnapshots puts them in Drive)
        asyncio.create_task(_log_submission("snapshot", {"feedback_id": fb["id"], "images": [{"name": f"{fb['id']}_{n}", "b64": base64.b64encode(d).decode()} for n, d in images][:40]}))
    return {"id": fb["id"], "flags": len(ann), "disputed": len(disputed), "proposals": len(proposal_urls), "proposal_urls": [u for u in proposal_urls if u]}


# ---------------------------------------------------------------- proposals (new slop patterns)
PROPOSALS_REPO = os.environ.get("SCISLOP_PROPOSALS_REPO", "yerimoh/scientific-slop-demo")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
SNAPSHOT_REPO = os.environ.get("SCISLOP_SNAPSHOT_REPO", "")   # e.g. yerimoh/scislop-submissions: flagged-region images are committed there


def _push_snapshots(fid: str, images: list) -> list:
    """Commit the snapshot images of one feedback to the snapshot repo (GitHub Contents API) and return their raw URLs.
    A durable home for the pictures: the sheet links them and previews the first one. Empty list when not configured."""
    if not (GITHUB_TOKEN and SNAPSHOT_REPO):
        return []
    import base64
    import urllib.request
    urls = []
    for name, data in images[:40]:
        path = f"snapshots/{fid}/{name}"
        body = json.dumps({"message": f"snapshot {fid}/{name}", "content": base64.b64encode(data).decode()}).encode()
        req = urllib.request.Request(f"https://api.github.com/repos/{SNAPSHOT_REPO}/contents/{path}", data=body, method="PUT",
                                     headers={"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                urls.append(json.load(r)["content"]["download_url"])
        except Exception as e:  # noqa: BLE001
            print("snapshot push failed:", e)
            break
    return urls
PROPOSALS_DIR = os.path.join(DATA, "proposals")
_PROPOSAL_CACHE: dict = {"at": 0.0, "items": []}
PROPOSAL_FIELDS = ("name", "plane", "what", "unit", "numerator", "denominator", "one_means", "detect", "example_url", "example_quote", "example2_url", "example2_quote",
                   "author", "affiliation", "email", "credit_site", "credit_paper")
PROPOSAL_STATUS = {"accepted": "Accepted", "not-adopted": "Not adopted", "under-review": "Under review", "testing": "Testing on SciSlopBench"}


def _proposal_markdown(pr: dict) -> str:
    plane = pr.get("plane") or "unassigned"
    lines = [f"**Plane:** {plane}", "", f"**What it is:** {pr.get('what', '')}", "", f"**Unit of analysis:** {pr.get('unit', '')}", "",
             "**Score =**", "", f"> {pr.get('numerator', '')}", "> ───", f"> {pr.get('denominator', '')}", "",
             f"**A score of 100 means:** {pr.get('one_means', '')}", "", f"**How to detect it:** {pr.get('detect', '') or '—'}", ""]
    for k in ("", "2"):
        if pr.get(f"example{k}_url") or pr.get(f"example{k}_quote"):
            lines += [f"**Example{' ' + k if k else ''}:** {pr.get(f'example{k}_url', '')}", "", f"> {pr.get(f'example{k}_quote', '')}", ""]
    who = pr.get("author") or "Anonymous"
    if pr.get("affiliation"):
        who += f" ({pr['affiliation']})"
    credit = [c for c, on in (("listed on the site", pr.get("credit_site")), ("contributor on the next paper version", pr.get("credit_paper"))) if on]
    lines += ["---", f"Proposed by {who}." + (f" Credit requested: {', '.join(credit)}." if credit else ""), f"Proposal id `{pr['id']}` · submitted via the Science Slop Index site."]
    return "\n".join(lines)


def _github_issue(pr: dict) -> Optional[str]:
    """Create a GitHub issue for the proposal (durable inbox). Returns the issue URL, or None without a token."""
    if not GITHUB_TOKEN:
        return None
    import urllib.request
    body = json.dumps({"title": f"Proposal: {pr['name']}", "body": _proposal_markdown(pr), "labels": ["proposal", "under-review"]}).encode()
    req = urllib.request.Request(f"https://api.github.com/repos/{PROPOSALS_REPO}/issues", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r).get("html_url")
    except Exception as e:  # noqa: BLE001
        print("github issue failed:", e)
        return None


def _github_proposals() -> list:
    """Proposals that live as GitHub issues (public read, cached 5 minutes). Status comes from labels."""
    if time.time() - _PROPOSAL_CACHE["at"] < 300:
        return _PROPOSAL_CACHE["items"]
    import urllib.request
    items = []
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{PROPOSALS_REPO}/issues?labels=proposal&state=all&per_page=100",
                                     headers={"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {GITHUB_TOKEN}"} if GITHUB_TOKEN else {})})
        with urllib.request.urlopen(req, timeout=15) as r:
            for it in json.load(r):
                labels = [l["name"] for l in it.get("labels", [])]
                status = next((k for k in ("accepted", "not-adopted", "testing", "under-review") if k in labels), "under-review")
                body = it.get("body") or ""
                m_plane = re.search(r"\*\*Plane:\*\* (\w+)", body); m_what = re.search(r"\*\*What it is:\*\* (.+)", body)
                m_by = re.search(r"Proposed by (.+?)\.", body)
                items.append({"id": f"gh-{it['number']}", "name": re.sub(r"^Proposal:\s*", "", it["title"]), "plane": (m_plane.group(1).lower() if m_plane else None),
                              "what": (m_what.group(1).strip() if m_what else ""), "author": (m_by.group(1) if m_by else "Anonymous"),
                              "status": status, "status_label": PROPOSAL_STATUS[status], "url": it["html_url"], "created": it.get("created_at")})
    except Exception as e:  # noqa: BLE001
        print("github proposals fetch failed:", e)
    _PROPOSAL_CACHE.update(at=time.time(), items=items)
    return items


async def _warm_up():
    """After a (re)start: make sure the featured paper's PDF and first page are on disk, so the home loads fast."""
    await asyncio.sleep(2)
    key = os.environ.get("SCISLOP_FEATURED", "sut7-28cn-z7r6")
    job = JOBS.get(key)
    if not job:
        return
    try:
        if not _find_file(key, "page_0.jpg"):
            src = await _ensure_pdf(job)
            if src:
                img = await asyncio.to_thread(page_image, src, 0)
                cache = os.path.join(_job_dir(key), "files", "page_0.jpg")
                os.makedirs(os.path.dirname(cache), exist_ok=True)
                with open(cache, "wb") as f:
                    f.write(img)
        await asyncio.to_thread(_github_proposals)      # fill the proposals cache
    except Exception as e:  # noqa: BLE001
        print("warm-up skipped:", e)


@app.on_event("startup")
async def _startup_warm():
    asyncio.create_task(_warm_up())


@app.get("/api/proposals")
async def proposals():
    gh = await asyncio.to_thread(_github_proposals)
    local = []
    if os.path.isdir(PROPOSALS_DIR):
        for f in sorted(os.listdir(PROPOSALS_DIR)):
            try:
                with open(os.path.join(PROPOSALS_DIR, f)) as fh:
                    pr = json.load(fh)
                if pr.get("issue_url"):
                    continue          # already listed through GitHub
                local.append({"id": pr["id"], "name": pr["name"], "plane": pr.get("plane"), "what": pr.get("what", ""), "author": pr.get("author") or "Anonymous",
                              "status": "under-review", "status_label": PROPOSAL_STATUS["under-review"], "url": None, "created": pr.get("created")})
            except Exception:  # noqa: BLE001
                continue
    return {"items": gh + local, "github": bool(GITHUB_TOKEN), "repo": PROPOSALS_REPO,
            "existing": [{"key": k, "name": v} for k, v in (("cross_refs", "Cross-section references"), ("macro_redundancy", "Macro redundancy"), ("argument_graph", "Argument graph"),
                                                             ("citation_isolation", "Citation isolation"), ("figure_exposition", "Figure exposition"), ("evidence_gap", "Evidence gap"))]}


@app.post("/api/proposals")
async def propose(request: Request, body: dict):
    _rate_limit(request)
    pr = {k: (str(body.get(k) or "").strip()[:2000] if not k.startswith("credit_") else bool(body.get(k))) for k in PROPOSAL_FIELDS}
    if len(pr["name"]) < 3 or len(pr["what"]) < 10:
        raise HTTPException(400, "Give the pattern a short name and one sentence on what a reader would notice.")
    if pr["plane"] not in ("structure", "argument", "artifacts", "other"):
        pr["plane"] = "other"
    pr["id"] = _new_key(); pr["created"] = time.time()
    os.makedirs(PROPOSALS_DIR, exist_ok=True)
    pr["issue_url"] = await asyncio.to_thread(_github_issue, pr)
    with open(os.path.join(PROPOSALS_DIR, pr["id"] + ".json"), "w") as f:
        json.dump(pr, f)
    _PROPOSAL_CACHE["at"] = 0.0
    if pr["author"]:
        _add_contributor(pr["author"], "pattern")
    await _log_submission("proposal", {"id": pr["id"], **{k: pr[k] for k in PROPOSAL_FIELDS}, "issue_url": pr["issue_url"] or ""})
    fallback = f"https://github.com/{PROPOSALS_REPO}/issues/new?" + __import__("urllib.parse").parse.urlencode({"title": f"Proposal: {pr['name']}", "body": _proposal_markdown(pr), "labels": "proposal,under-review"})
    return {"id": pr["id"], "issue_url": pr["issue_url"], "fallback_issue_url": None if pr["issue_url"] else fallback}


@app.get("/api/config")
async def config():
    llm = LLM()
    featured = os.environ.get("SCISLOP_FEATURED", "sut7-28cn-z7r6")
    if featured not in JOBS:
        featured = next((k for k, j in JOBS.items() if j.get("status") == "done" and j.get("gallery")), None)
    return {"llm": llm.describe(), "llm_available": llm.available, "byok": True, "featured": featured,
            "key_provider": "OpenRouter" if llm.provider == "openrouter" else llm.describe().get("provider", "the LLM gateway"),
            "max_upload_mb": MAX_UPLOAD // (1024 * 1024),
            "persistent": PERSISTENT,
            "examples": [{"id": k, "title": v["title"], "venue": v["venue"]} for k, v in EXAMPLES.items()
                         if os.path.isdir(v["path"])]}


app.add_middleware(CORSMiddleware,
                   allow_origins=[o.strip() for o in os.environ.get("SCISLOP_CORS_ORIGINS", "https://yerimoh.github.io,http://localhost:8822").split(",") if o.strip()],
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(os.path.join(HERE, "static", "favicon-32.png"), media_type="image/png")


@app.get("/")
@app.get("/leaderboard")
@app.get("/how")
@app.get("/gallery")
@app.get("/view")
@app.get("/propose")
@app.get("/r/{key}")
async def index(key: Optional[str] = None):
    return FileResponse(os.path.join(HERE, "static", "index.html"))
