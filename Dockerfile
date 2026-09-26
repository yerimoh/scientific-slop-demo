FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY engine ./engine
COPY static ./static
COPY seed ./seed
COPY server.py cli.py ./

ENV PATH="/app/.venv/bin:$PATH" SCISLOP_DATA=/app/data PORT=8000
RUN useradd --create-home app && mkdir -p /app/data && chown -R app /app/data
USER app
EXPOSE 8000
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
