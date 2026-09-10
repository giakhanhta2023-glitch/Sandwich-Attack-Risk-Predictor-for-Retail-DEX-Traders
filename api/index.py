"""Vercel serverless entry point.

`app` is a plain module-level ASGI callable, and that shape is deliberate.
Vercel decides whether a file in `api/` is a function by inspecting it
statically; binding `app` only inside a `try`/`except` defeats that and the
build fails outright with "the pattern api/index.py doesn't match any
Serverless Functions". So the export is unconditional and the real application
is loaded lazily on the first request instead.

That also buys better diagnostics than a module-level import allows. A cold
start that raises leaves nothing but FUNCTION_INVOCATION_FAILED and a traceback
in runtime logs that are not always reachable; here the failure is captured and
returned over HTTP. The handler uses only the standard library, so it still
answers when the failure is a missing dependency.

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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_real_app = None
_load_error: str | None = None


def _load():
    """Import the FastAPI application once, remembering any failure."""
    global _real_app, _load_error
    if _real_app is not None or _load_error is not None:
        return
    try:
        from backend.app.main import app as fastapi_app

        _real_app = fastapi_app
    except Exception:
        _load_error = traceback.format_exc()


async def app(scope, receive, send):
    """ASGI entry: delegate to FastAPI, or explain why it could not load."""
    _load()

    if _real_app is not None:
        await _real_app(scope, receive, send)
        return

    if scope["type"] != "http":
        return

    body = json.dumps(
        {
            "error": "backend import failed during cold start",
            "python": sys.version,
            "cwd": str(Path.cwd()),
            "root_entries": sorted(p.name for p in ROOT.iterdir())[:40],
            "sys_path_head": sys.path[:6],
            "traceback": (_load_error or "").splitlines()[-30:],
        },
        indent=1,
    ).encode()

    await send({
        "type": "http.response.start",
        "status": 500,
        "headers": [[b"content-type", b"application/json"]],
    })
    await send({"type": "http.response.body", "body": body})
