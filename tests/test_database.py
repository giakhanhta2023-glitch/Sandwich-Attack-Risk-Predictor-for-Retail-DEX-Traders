"""Database layer contract.

The property that matters most here is not that the database works -- it is that
the application still works when the database does not. A missing or misbehaving
Supabase connection must degrade to the local corpus rather than take down a risk
score, so these tests pin that behaviour by forcing the client to be absent.
"""

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.db import repository as repo
from backend.db.client import DatabaseUnavailable, db_status


@pytest.fixture
def no_database(monkeypatch):
    """Simulate an unconfigured deployment."""
    monkeypatch.setattr(repo, "read_client", lambda: None)
    monkeypatch.setattr(repo, "write_client", lambda: None)

    def _refuse():
        raise DatabaseUnavailable("not configured")

    monkeypatch.setattr(repo, "require_write_client", _refuse)


@pytest.fixture
def broken_database(monkeypatch):
    """Simulate a database that is configured but failing."""

    class Boom:
        def table(self, *_a, **_k):
            raise RuntimeError("connection reset")

    monkeypatch.setattr(repo, "read_client", lambda: Boom())
    monkeypatch.setattr(repo, "write_client", lambda: Boom())
    monkeypatch.setattr(repo, "require_write_client", lambda: Boom())


# ------------------------------------------------------- graceful degradation

def test_reads_return_empty_without_a_database(no_database):
    assert repo.fetch_pools() is None
    assert repo.pool_risk_stats() == []
    assert repo.severity_buckets() == []
    assert repo.recent_sandwiches() == []
    assert repo.model_run_history() == []
    assert repo.counts() == {}
    assert repo.get_cursor("helius:solana") is None


def test_telemetry_is_silent_without_a_database(no_database):
    """Logging must never be the reason a request fails."""
    repo.log_analysis({"pool_id": "x"})
    repo.update_cursor("helius:solana", last_block=1)
    assert repo.record_model_run({"metrics": {}}) is None


def test_telemetry_swallows_backend_failures(broken_database):
    """A database that is up but erroring must not surface to the caller."""
    repo.log_analysis({"pool_id": "x"})
    repo.update_cursor("helius:solana", last_block=1)
    assert repo.record_model_run({"metrics": {}}) is None
    assert repo.pool_risk_stats() == []
    assert repo.fetch_pools() is None


def test_writes_are_refused_rather_than_silently_dropped(no_database):
    """Ingestion is not telemetry: losing swaps silently would corrupt the corpus."""
    with pytest.raises(DatabaseUnavailable):
        repo.insert_swaps([object()])
    with pytest.raises(DatabaseUnavailable):
        repo.insert_sandwich_events([object()])


def test_empty_payloads_do_not_touch_the_database(no_database):
    """Nothing to write means no call at all, so an empty pull is not an error."""
    assert repo.insert_swaps([]) == 0
    assert repo.insert_sandwich_events([]) == 0


# ------------------------------------------------------------------ the API

@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_health_reports_database_state(client):
    body = client.get("/api/health").json()
    assert "database" in body
    assert set(body["database"]) >= {"configured", "readable", "writable", "detail"}
    assert "database" in body["sources"]


def test_db_status_endpoint(client):
    body = client.get("/api/db/status").json()
    assert "configured" in body and "counts" in body


def test_analysis_still_scores_when_the_database_is_down(client, broken_database):
    """The whole point of the fallback: a broken database costs telemetry, not answers."""
    res = client.post(
        "/api/analyze",
        json={"pool_id": "ray-bonk-sol", "notional_usd": 8000, "slippage_bps": 300},
    )
    assert res.status_code == 200
    body = res.json()
    assert 0.0 <= body["risk"]["p_attack"] <= 1.0
    assert body["sweet_spot"]["slippage_bps"] > 0


def test_sync_pools_refuses_without_a_service_key(client, no_database):
    res = client.post("/api/db/sync-pools")
    assert res.status_code == 503
    assert res.json()["detail"]


def test_write_refusal_message_names_the_missing_setting(monkeypatch):
    """The error has to tell the operator what to do, not just that it failed.

    Driven off a stubbed settings object rather than the ambient environment, so
    the assertion holds whether or not a real service key is configured.
    """
    import backend.db.client as db_client

    class NoServiceKey:
        supabase_url = "https://example.supabase.co"
        supabase_publishable_key = "sb_publishable_x"
        supabase_service_key = ""

    monkeypatch.setattr(db_client, "settings", NoServiceKey())
    db_client._client.cache_clear()
    try:
        with pytest.raises(DatabaseUnavailable) as err:
            db_client.require_write_client()
        assert "SUPABASE_SERVICE_KEY" in str(err.value)
    finally:
        db_client._client.cache_clear()


def test_status_shape_is_stable():
    status = db_status()
    assert set(status) == {"configured", "readable", "writable", "url", "detail"}
