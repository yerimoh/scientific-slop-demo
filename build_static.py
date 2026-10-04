"""Build a static mirror of the site (GitHub Pages) into docs/.

Everything a visitor reads is pre-rendered: config, gallery, every report, its page images, thumbnail,
figures, layout, highlighted PDF and CSV. New analyses and proposals hand off to the live server.
Usage: .venv/bin/python build_static.py [--base /scientific-slop-demo] [--live https://scientific-slop-demo.onrender.com]
"""
import argparse, asyncio, csv, io, json, os, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
ap = argparse.ArgumentParser(); ap.add_argument("--base", default="/scientific-slop-demo"); ap.add_argument("--live", default="https://scientific-slop-demo.onrender.com")
ap.add_argument("--out", default=os.path.join(HERE, "docs")); ap.add_argument("--repo", default="yerimoh/scientific-slop-demo")
ap.add_argument("--max-pages", type=int, default=40, help="pages shipped per paper; the rest hand off to the live site")
args = ap.parse_args()
import server  # noqa: E402  (indexes seed + data jobs at import)
from engine.highlight import annotated_pdf, page_image  # noqa: E402

OUT = args.out
if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(os.path.join(OUT, "api", "jobs"), exist_ok=True)

def dump(rel, obj):
    p = os.path.join(OUT, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(obj, f)

async def main():
    gal = await server.gallery()
    dump("api/gallery.json", gal)
    featured = os.environ.get("SCISLOP_FEATURED", "sut7-28cn-z7r6")
    dump("api/config.json", {"llm": {"model": "", "provider": ""}, "llm_available": False, "byok": False, "static": True, "live": args.live, "max_pages": args.max_pages,
                             "featured": featured if featured in server.JOBS else (gal["items"][0]["key"] if gal["items"] else None),
                             "max_upload_mb": 0, "persistent": True, "examples": []})
    dump("api/contributors.json", await server.contributors())
    # home-page counter: the live server's count at build time (the page refreshes it from the live server)
    try:
        import httpx
        async with httpx.AsyncClient(timeout=60) as c:
            st = (await c.get(args.live.rstrip("/") + "/api/stats")).json()
    except Exception:  # noqa: BLE001
        st = await server.stats()
    dump("api/stats.json", st)
    for item in gal["items"]:
        key = item["key"]; job = server.JOBS[key]; res = job.get("result") or {}
        jd = os.path.join(OUT, "api", "jobs", key); os.makedirs(os.path.join(jd, "pages"), exist_ok=True); os.makedirs(os.path.join(jd, "files"), exist_ok=True)
        dump(f"api/jobs/{key}.json", {k: v for k, v in job.items() if not k.startswith("_")})
        # shipped files: thumb, figures, layout, first page
        for base in (server.JOBS_DIR, server.SEED_DIR):
            d = os.path.join(base, key, "files")
            if os.path.isdir(d):
                for f in os.listdir(d):
                    if f.endswith((".png", ".json")) and not os.path.exists(os.path.join(jd, "files", f)):
                        shutil.copyfile(os.path.join(d, f), os.path.join(jd, "files", f))
        if os.path.exists(os.path.join(jd, "files", "thumb.png")):
            shutil.move(os.path.join(jd, "files", "thumb.png"), os.path.join(jd, "thumb.png"))
        if os.path.exists(os.path.join(jd, "files", "layout.json")):
            shutil.move(os.path.join(jd, "files", "layout.json"), os.path.join(jd, "layout.json"))
        pdf = (res.get("pdf") or {})
        if pdf.get("available"):
            src = await server._ensure_pdf(job)
            if src:
                import pymupdf
                with pymupdf.open(src) as doc_:
                    for n in range(min(pdf.get("pages", 0), args.max_pages)):
                        page = doc_[n]; z = 1000 / page.rect.width
                        with open(os.path.join(jd, "pages", f"{n}.jpg"), "wb") as f:
                            f.write(page.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False).tobytes("jpeg", jpg_quality=70))
                os.makedirs(os.path.join(jd, "words"), exist_ok=True)
                for n in range(min(pdf.get("pages", 0), args.max_pages)):
                    dump(f"api/jobs/{key}/words/{n}.json", server._page_words(src, n))
                with open(os.path.join(jd, "pdf"), "wb") as f:
                    f.write(annotated_pdf(src, res))
                if not os.path.exists(os.path.join(jd, "layout.json")):
                    dump(f"api/jobs/{key}/layout.json", server._layout_nodes(src, res))
        # csv export
        buf = io.StringIO(); w = csv.writer(buf)
        w.writerow(["measure", "plane", "measure_score", "section", "pdf_pages", "finding", "detail"])
        for m in res.get("measures", []):
            sc = "" if m.get("score") is None else round(m["score"], 4)
            if not m.get("instances"):
                w.writerow([m["name"], m["plane"], sc, "", "", "", "; ".join(m.get("notes", []))])
            for it in m.get("instances", []):
                pages = sorted({l["p"] + 1 for l in it.get("pdf", [])})
                detail = it.get("why") or (f"{round(100 * it['coverage'])}% copied from {it.get('source_title')}" if "coverage" in it else it.get("caption", ""))
                w.writerow([m["name"], m["plane"], sc, it.get("section_title", ""), " ".join(map(str, pages)), it.get("text", ""), detail])
        with open(os.path.join(jd, "export.csv"), "w") as f:
            f.write(buf.getvalue())
        print("built", key, item["title"][:40])
    # static assets and the page shell
    shutil.copytree(os.path.join(HERE, "static"), os.path.join(OUT, "static"))
    html = open(os.path.join(HERE, "static", "index.html")).read()
    html = html.replace('href="/static/', f'href="{args.base}/static/').replace('src="/static/', f'src="{args.base}/static/')
    keys = json.dumps([it["key"] for it in gal["items"]])
    html = html.replace("<head>", f"<head>\n<script>window.SCISLOP_STATIC = {{ base: '{args.base}', live: '{args.live}', repo: '{args.repo}', keys: {keys} }};</script>", 1)
    for name in ("index.html", "404.html"):
        with open(os.path.join(OUT, name), "w") as f:
            f.write(html)
    open(os.path.join(OUT, ".nojekyll"), "w").close()
    print("done →", OUT)

asyncio.run(main())
