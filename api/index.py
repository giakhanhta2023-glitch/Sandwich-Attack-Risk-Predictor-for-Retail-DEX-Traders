"""Vercel serverless entry point.

Vercel's Python runtime serves an ASGI application exported as `app`, so this
re-exports the FastAPI instance. It also puts the repository root on `sys.path`,
since the function's working directory is not the project root.

The import is guarded. A serverless cold-start failure surfaces only as
FUNCTION_INVOCATION_FAILED with the traceback buried in runtime logs, which are
not always reachable; swapping in a tiny app that reports the traceback over
HTTP turns a silent 500 into something diagnosable from the outside.

The deployed dependency set (`requirements.txt` at the repo root) omits
scikit-learn, numpy and pandas -- together ~370MB against a 250MB function
limit. The API detects their absence and serves the closed-form economics,
reporting `serving.mode == "fallback"` so the UI states which predictor is live.
"""

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    from backend.app.main import app
except Exception:  # pragma: no cover - deployment diagnostics only
    _TRACEBACK = traceback.format_exc()

    from fastapi import FastAPI

    app = FastAPI()

    @app.get("/{full_path:path}")
    def _import_failed(full_path: str) -> dict[str, object]:
        return {
            "error": "backend import failed during cold start",
            "path": full_path,
            "python": sys.version,
            "sys_path": sys.path[:5],
            "cwd": str(Path.cwd()),
            "root_entries": sorted(p.name for p in Path.cwd().iterdir())[:40],
            "traceback": _TRACEBACK.splitlines()[-25:],
        }

__all__ = ["app"]
