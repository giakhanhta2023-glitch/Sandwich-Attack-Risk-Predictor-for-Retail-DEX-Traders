"""Vercel serverless entry point.

Vercel's Python runtime detects an ASGI application exported as `app` and serves
it directly, so this re-exports the FastAPI instance and adds the one thing the
platform needs that local development does not: the repository root on
`sys.path`, since the function's working directory is not the project root.

Note the deployed dependency set (`requirements.txt` at the repo root) omits
scikit-learn, numpy and pandas. Together they are roughly 200MB unpacked, which
does not fit inside a serverless function alongside everything else. The API
detects their absence and serves the closed-form economics instead, reporting
`serving.mode == "fallback"` so the UI states which predictor is live.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.main import app  # noqa: E402

__all__ = ["app"]
