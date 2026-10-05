FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Tectonic typesets uploaded LaTeX sources that come without a PDF (self-contained XeTeX; packages are
# fetched on demand). A warm-up build pulls the packages most papers use into the image's cache.
ADD https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz /tmp/tectonic.tar.gz
RUN tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic && rm /tmp/tectonic.tar.gz && chmod 755 /usr/local/bin/tectonic
ENV TECTONIC_CACHE_DIR=/app/.tectonic
COPY docker/warmup.tex /tmp/warmup/warmup.tex
RUN mkdir -p /app/.tectonic && cd /tmp/warmup && tectonic -X compile -Z continue-on-errors warmup.tex >/dev/null 2>&1 || true; rm -rf /tmp/warmup

COPY engine ./engine
COPY static ./static
COPY seed ./seed
COPY server.py cli.py ./

ENV PATH="/app/.venv/bin:$PATH" SCISLOP_DATA=/app/data PORT=8000
# glibc tuning: without this, memory freed by page renders stays in per-thread arenas and the resident size
# climbs until the instance is OOM-killed (measured: 400 renders +674 MiB untuned, +186 MiB with these)
ENV MALLOC_ARENA_MAX=2 MALLOC_TRIM_THRESHOLD_=131072 MALLOC_MMAP_THRESHOLD_=131072
RUN useradd --create-home app && mkdir -p /app/data && chown -R app /app/data /app/.tectonic
USER app
EXPOSE 8000
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
