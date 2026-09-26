#!/bin/bash
# Start the Science Slop Index website on http://localhost:${PORT:-8811}
cd "$(dirname "$0")"
exec uv run uvicorn server:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8811}"
