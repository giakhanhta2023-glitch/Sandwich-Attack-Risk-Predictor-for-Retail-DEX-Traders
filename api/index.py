"""Vercel serverless entry point.

Vercel's Python runtime serves an ASGI application exported as `app`, so this
re-exports the FastAPI instance, with the repository root added to `sys.path`
because the function's working directory is not the project root.

The import is guarded, and the guard deliberately uses a raw ASGI callable with
no third-party imports. An earlier version fell back to a small FastAPI app,
which is useless precisely when it is needed most: if the cold start failed
because dependencies were missing, the fallback's own `import fastapi` failed
too and the function died with an opaque FUNCTION_INVOCATION_FAILED. Standard
library only means the diagnostic always answers.

The deployed dependency set omits scikit-learn, numpy and pandas -- together
~370MB against a 250MB function limit. The API detects their absence and serves
the closed-form economics, reporting `serving.mode == "fallback"` so the UI
states which predictor is live.
"""

import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    from backend.app.main import app
except Exception:  # pragma: no cover - deployment diagnostics only
    _DIAGNOSTIC = {
        "error": "backend import failed during cold start",
        "python": sys.version,
        "cwd": str(Path.cwd()),
        "entrypoint_dir": str(Path(__file__).resolve().parent),
        "root_entries": sorted(p.name for p in ROOT.iterdir())[:40],
        "sys_path_head": sys.path[:6],
        "installed_sample": sorted(
            {m.split(".")[0] for m in sys.modules if not m.startswith("_")}
        )[:60],
        "traceback": traceback.format_exc().splitlines()[-30:],
    }

    async def app(scope, receive, send):  # type: ignore[misc]
        """Minimal ASGI app: reports why the real one could not load."""
        if scope["type"] != "http":
            return
        body = json.dumps(_DIAGNOSTIC, indent=1).encode()
        await send({
            "type": "http.response.start",
            "status": 500,
            "headers": [[b"content-type", b"application/json"]],
        })
        await send({"type": "http.response.body", "body": body})

__all__ = ["app"]
