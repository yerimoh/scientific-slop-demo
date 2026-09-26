"""Score papers from the command line.

    uv run python cli.py path/to/paper.pdf
    uv run python cli.py path/to/latex_project_dir_or.zip
    uv run python cli.py https://arxiv.org/abs/2303.17651 --json out.json
"""
import argparse
import asyncio
import json
import os
import sys
import tempfile

from server import _load_dotenv  # noqa: F401  (loads .env)
from engine.fetch import materialize, resolve_url
from engine.llm import LLM
from engine.pipeline import analyze_document, read_document


async def run(target: str, out: str | None):
    work = tempfile.mkdtemp(prefix="scislop_")
    if target.startswith(("http://", "https://", "arxiv:")):
        kind, path, meta = await resolve_url(target, work)
    elif os.path.isdir(target):
        kind, path, meta = "latex", target, {"route": "LaTeX directory"}
    else:
        kind, path = materialize(open(target, "rb").read(), os.path.basename(target), work)
        meta = {"route": "file"}
    doc = read_document(kind, path)
    res = await analyze_document(doc, LLM(), os.path.join(work, "files"), meta=meta)
    idx = res["index"]
    print(f"\n{res['document']['title']}\n  Science Slop Index: {idx['index']} / 100" + ("  (partial)" if idx["partial"] else ""))
    for p, v in idx["planes"].items():
        print(f"  {p:10s} {'—' if v['score'] is None else round(100 * v['score'])}")
    for m in res["measures"]:
        sc = "—" if m["score"] is None else f"{m['score']:.3f} ({m['num']}/{m['den']})"
        print(f"    {m['name']:26s} {m['status']:8s} {sc}")
    if out:
        with open(out, "w") as f:
            json.dump(res, f, indent=2)
        print(f"\n  report written to {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--json")
    a = ap.parse_args()
    sys.exit(asyncio.run(run(a.target, a.json)))
