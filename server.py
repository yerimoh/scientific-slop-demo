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

async def _run(job: dict, kind: Optional[str], path: Optional[str], url: Optional[str], meta: dict):
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
            if not doc.title and view_pdf:
                doc.title = await asyncio.to_thread(_pdf_title, view_pdf)
            job["document"] = document_summary(doc, meta)
            job["stage"] = "Measuring"
            llm = LLM()

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
                  example: Optional[str] = Form(None), gallery: Optional[str] = Form(None)):
    meta: dict = {}
    if not example:
        _rate_limit(request)
    if example:
        ex = EXAMPLES.get(example)
        if not ex or not os.path.isdir(ex["path"]):
            raise HTTPException(404, "Example not available on this server.")
        job = _new_job(ex["title"], gallery=False)
        meta.update({"route": ex["venue"], "fallback_title": ex["title"]})
        asyncio.create_task(_run(job, "latex", ex["path"], None, meta))
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
        asyncio.create_task(_run(job, kind, path, None, meta))
        return {"id": job["id"], "key": job["id"]}
    if url and url.strip():
        job = _new_job(url.strip(), gallery=True)       # public links are listed in the gallery
        asyncio.create_task(_run(job, None, None, url.strip(), meta))
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
    result = await rerun_figure(doc, job["result"], LLM(), os.path.join(_job_dir(key), "files"), idx)
    job["result"] = result
    _save(job)
    return JSONResponse(result)


async def _ensure_pdf(job: dict) -> Optional[str]:
    """The paper's PDF for a report. Gallery seeds ship without it and fetch it from their public link."""
    key = job["id"]
    have = _find_file(key, "paper.pdf")
    if have:
        return have
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
        })
    return {"items": items, "persistent": PERSISTENT}


@app.get("/api/config")
async def config():
    llm = LLM()
    return {"llm": llm.describe(), "llm_available": llm.available, "max_upload_mb": MAX_UPLOAD // (1024 * 1024),
            "persistent": PERSISTENT,
            "examples": [{"id": k, "title": v["title"], "venue": v["venue"]} for k, v in EXAMPLES.items()
                         if os.path.isdir(v["path"])]}


app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")


@app.get("/")
@app.get("/how")
@app.get("/gallery")
@app.get("/view")
@app.get("/r/{key}")
async def index(key: Optional[str] = None):
    return FileResponse(os.path.join(HERE, "static", "index.html"))
