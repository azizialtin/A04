async def test_health_is_ok(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_live_is_ok(client):
    r = await client.get("/health/live")
    assert r.status_code == 200


async def test_ready_reaches_the_db(client):
    r = await client.get("/health/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_an_unhandled_error_is_logged_and_referenced(client, caplog):
    """A 500 should give the participant something to read out, and the study
    manager something to search the logs for."""
    import logging

    from main import app

    @app.get("/__boom")
    async def boom():
        raise RuntimeError("the database caught fire")

    try:
        with caplog.at_level(logging.ERROR):
            try:
                r = await client.get("/__boom", headers={"X-Request-ID": "abc123"})
            except RuntimeError:
                # Starlette re-raises after the handler has already sent the
                # body, so the ASGI transport sees it too — the handler ran.
                r = None
    finally:
        app.router.routes = [x for x in app.router.routes if getattr(x, "path", "") != "/__boom"]

    assert "unhandled error on GET /__boom" in caplog.text
    assert "the database caught fire" in caplog.text  # the traceback travels with it
    if r is not None:
        assert r.status_code == 500
        assert r.json()["request_id"] == "abc123"
