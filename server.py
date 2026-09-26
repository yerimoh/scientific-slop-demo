"""Science Slop Index web server.

    uv run uvicorn server:app --port 8811

POST /api/analyze        multipart: file=<pdf|zip|tar.gz|tex>  or  url=<arXiv/OpenReview/PDF link>  or  example=<id>
GET  /api/jobs/{id}      progress while running, the full report when done
POST /api/jobs/{id}/figure   {"index": k}  re-score Figure exposition on another figure
GET  /api/jobs/{id}/files/{name}   rendered method-figure images
GET  /api/config         model and examples
"""
from __future__ import annotations

import asyncio
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
from fastapi.responses import FileResponse, JSONResponse
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

from engine.fetch import InputError, materialize, resolve_url  # noqa: E402
from engine.llm import LLM  # noqa: E402
from engine.pipeline import analyze_document, document_summary, read_document, rerun_figure  # noqa: E402

DATA = os.environ.get("SCISLOP_DATA", os.path.join(HERE, "data"))
JOBS_DIR = os.path.join(DATA, "jobs")
os.makedirs(JOBS_DIR, exist_ok=True)
MAX_UPLOAD = int(os.environ.get("SCISLOP_MAX_UPLOAD_MB", "50")) * 1024 * 1024
RATE_PER_HOUR = int(os.environ.get("SCISLOP_RATE_PER_HOUR", "20"))       # analyses per client IP per hour
MAX_CONCURRENT = int(os.environ.get("SCISLOP_MAX_CONCURRENT", "2"))      # analyses running at once
MAX_DOCS = int(os.environ.get("SCISLOP_MAX_DOCS", "24"))                 # parsed papers kept for figure re-scoring

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


def _remember_doc(jid: str, doc):
    DOCS[jid] = doc
    DOCS.move_to_end(jid)
    while len(DOCS) > MAX_DOCS:
        DOCS.popitem(last=False)
    # finished jobs live on disk; keep only recent ones in memory
    if len(JOBS) > 200:
        for k in sorted(JOBS, key=lambda k: JOBS[k].get("created", 0))[:len(JOBS) - 200]:
            if JOBS[k].get("status") != "running":
                JOBS.pop(k, None)


def _job_dir(jid: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,40}", jid):
        raise HTTPException(404, "Unknown report")
    return os.path.join(JOBS_DIR, jid)


def _save(job: dict):
    d = _job_dir(job["id"])
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "job.json"), "w") as f:
        json.dump({k: v for k, v in job.items() if not k.startswith("_")}, f)


def _load(jid: str) -> Optional[dict]:
    if jid in JOBS:
        return JOBS[jid]
    p = os.path.join(_job_dir(jid), "job.json")
    if os.path.exists(p):
        with open(p) as f:
            job = json.load(f)
        JOBS[jid] = job
        return job
    return None


async def _run(job: dict, kind: Optional[str], path: Optional[str], url: Optional[str], meta: dict):
    jid = job["id"]
    workdir = _job_dir(jid)
    try:
        if RUN_SLOTS.locked():
            job["stage"] = "Waiting in line"
        async with RUN_SLOTS:
            if url:
                job["stage"] = "Fetching the paper"
                kind, path, m2 = await resolve_url(url, workdir)
                meta.update(m2)
            job["stage"] = "Reading the paper"
            doc = await asyncio.to_thread(read_document, kind, path)
            job["document"] = document_summary(doc, meta)
            job["stage"] = "Measuring"
            llm = LLM()

            async def emit(ev: str, payload: dict):
                if ev == "measure":
                    job["measures"][payload["key"]] = payload
                    job["running"] = [k for k in job["running"] if k != payload["key"]]
                elif ev == "running":
                    job["running"].append(payload["key"])

            result = await analyze_document(doc, llm, os.path.join(workdir, "files"), emit=emit, meta=meta)
            _remember_doc(jid, doc)
            job["result"] = result
            job["status"] = "done"
            job["stage"] = "Done"
    except InputError as e:
        job["status"], job["error"] = "error", str(e)
    except Exception as e:
        traceback.print_exc()
        job["status"], job["error"] = "error", f"Could not analyze this paper: {type(e).__name__}: {e}"
    finally:
        # uploaded or fetched sources are deleted once the report exists; rendered figures stay with it
        shutil.rmtree(os.path.join(workdir, "src"), ignore_errors=True)
        try:
            os.remove(os.path.join(workdir, "paper.pdf"))
        except OSError:
            pass
    job["finished"] = time.time()
    _save(job)


def _new_job(label: str) -> dict:
    jid = secrets.token_urlsafe(8).replace("-", "x").replace("_", "y")
    job = {"id": jid, "status": "running", "stage": "Queued", "label": label, "created": time.time(),
           "measures": {}, "running": [], "document": None, "result": None, "error": None}
    JOBS[jid] = job
    os.makedirs(_job_dir(jid), exist_ok=True)
    return job


@app.post("/api/analyze")
async def analyze(request: Request, file: Optional[UploadFile] = File(None), url: Optional[str] = Form(None),
                  example: Optional[str] = Form(None)):
    meta: dict = {}
    if not example:
        _rate_limit(request)
    if example:
        ex = EXAMPLES.get(example)
        if not ex or not os.path.isdir(ex["path"]):
            raise HTTPException(404, "Example not available on this server.")
        job = _new_job(ex["title"])
        meta.update({"route": ex["venue"], "fallback_title": ex["title"]})
        asyncio.create_task(_run(job, "latex", ex["path"], None, meta))
        return {"id": job["id"]}
    if file is not None and file.filename:
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"File is larger than {MAX_UPLOAD // (1024 * 1024)} MB.")
        if not data:
            raise HTTPException(400, "The file is empty.")
        job = _new_job(file.filename)
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
        asyncio.create_task(_run(job, kind, path, None, meta))
        return {"id": job["id"]}
    if url and url.strip():
        job = _new_job(url.strip())
        asyncio.create_task(_run(job, None, None, url.strip(), meta))
        return {"id": job["id"]}
    raise HTTPException(400, "Give a link or a file.")


@app.get("/api/jobs/{jid}")
async def job_status(jid: str):
    job = _load(jid)
    if not job:
        raise HTTPException(404, "Unknown report")
    return JSONResponse({k: v for k, v in job.items() if not k.startswith("_")})


@app.post("/api/jobs/{jid}/figure")
async def job_figure(jid: str, body: dict):
    job = _load(jid)
    doc = DOCS.get(jid)
    if not job or not job.get("result"):
        raise HTTPException(404, "Unknown report")
    if doc is None:
        raise HTTPException(409, "This report was restored from disk; re-run the analysis to switch figures.")
    idx = int(body.get("index", -1))
    result = await rerun_figure(doc, job["result"], LLM(), os.path.join(_job_dir(jid), "files"), idx)
    job["result"] = result
    _save(job)
    return JSONResponse(result)


@app.get("/api/jobs/{jid}/files/{name}")
async def job_file(jid: str, name: str):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.png", name):
        raise HTTPException(404)
    p = os.path.join(_job_dir(jid), "files", name)
    if not os.path.exists(p):
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png")


@app.get("/api/config")
async def config():
    llm = LLM()
    return {"llm": llm.describe(), "llm_available": llm.available, "max_upload_mb": MAX_UPLOAD // (1024 * 1024),
            "examples": [{"id": k, "title": v["title"], "venue": v["venue"]} for k, v in EXAMPLES.items()
                         if os.path.isdir(v["path"])]}


app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")


@app.get("/")
@app.get("/r/{jid}")
async def index(jid: Optional[str] = None):
    return FileResponse(os.path.join(HERE, "static", "index.html"))
