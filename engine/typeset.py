"""Typeset a LaTeX source tree into a PDF when the upload carries no compiled PDF.

Uses Tectonic (a self-contained XeTeX; downloads packages on first use and caches them), with
latexmk as a fallback for machines that have a full TeX Live. Errors are tolerated so that a
paper with a missing package or a bad citation still yields a PDF the findings can be placed on.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from typing import Optional

from .latex import find_main_tex


def _pdf_ok(path: str) -> bool:
    try:
        import pymupdf
        with pymupdf.open(path) as d:
            return len(d) >= 1
    except Exception:
        return False


def compile_latex(root: str, timeout: int = 300, log=None) -> Optional[str]:
    """Returns the path of the typeset PDF, or None when nothing could be produced."""
    main = find_main_tex(root)
    if not main:
        return None
    workdir = os.path.dirname(main)
    out_dir = os.path.join(root, "_typeset")
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(main))[0]
    pdf = os.path.join(out_dir, stem + ".pdf")
    env = dict(os.environ)
    env.setdefault("TECTONIC_CACHE_DIR", os.environ.get("SCISLOP_TECTONIC_CACHE", os.path.join(os.path.expanduser("~"), ".cache", "Tectonic")))
    import sys
    tectonic = os.environ.get("SCISLOP_TECTONIC") or shutil.which("tectonic") or shutil.which("tectonic", path=os.path.join(sys.prefix, "bin"))
    cmds = []
    if tectonic:
        cmds.append([tectonic, "-X", "compile", "--outdir", out_dir, "-Z", "continue-on-errors", "--keep-logs", os.path.basename(main)])
    latexmk = shutil.which("latexmk")
    if latexmk:
        cmds.append([latexmk, "-pdf", "-interaction=nonstopmode", "-halt-on-error-", "-f", f"-outdir={out_dir}", os.path.basename(main)])
    for cmd in cmds:
        try:
            r = subprocess.run(cmd, cwd=workdir, env=env, capture_output=True, text=True, timeout=timeout)
            if log:
                log(f"{os.path.basename(cmd[0])} exit {r.returncode}: {(r.stderr or r.stdout)[-400:]}")
        except (subprocess.TimeoutExpired, OSError) as e:
            if log:
                log(f"{os.path.basename(cmd[0])} failed: {e}")
            continue
        if os.path.exists(pdf) and _pdf_ok(pdf):
            return pdf
    return None
