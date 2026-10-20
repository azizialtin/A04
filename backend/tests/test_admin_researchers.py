"""Researcher accounts from the admin UI: the CLI's operations, over HTTP."""

PASSWORD = "correct-horse-battery"


async def _login(client, email: str, password: str):
    return await client.post("/auth/admin/login", json={"email": email, "password": password})


async def _colleague(client, admin_headers, email="colleague@a04.test") -> tuple[int, dict]:
    """A second account, signed in: its id and its auth headers."""
    r = await client.post(
        "/admin/researchers", json={"email": email, "password": PASSWORD}, headers=admin_headers
    )
    assert r.status_code == 201, r.text
    token = (await _login(client, email, PASSWORD)).json()["access_token"]
    return r.json()["id"], {"Authorization": f"Bearer {token}"}


async def test_accounts_are_listed_without_secrets(client, admin_headers, seed_researcher):
    r = await client.get("/admin/researchers", headers=admin_headers)
    assert r.status_code == 200
    [row] = r.json()
    assert row["email"] == "researcher@a04.test"
    assert row["name"] == "Test Researcher"
    assert set(row) == {"id", "email", "name", "created_at"}


async def test_a_new_account_can_log_in_straight_away(client, admin_headers):
    r = await client.post(
        "/admin/researchers",
        json={"email": "New.Admin@Uni.example", "name": " New Admin ", "password": PASSWORD},
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["email"] == "new.admin@uni.example"
    assert r.json()["name"] == "New Admin"
    assert (await _login(client, "new.admin@uni.example", PASSWORD)).status_code == 200
    assert len((await client.get("/admin/researchers", headers=admin_headers)).json()) == 2


async def test_creating_refuses_a_duplicate_a_short_password_and_a_non_address(
    client, admin_headers, seed_researcher
):
    dupe = await client.post(
        "/admin/researchers",
        json={"email": "RESEARCHER@a04.test", "password": PASSWORD},
        headers=admin_headers,
    )
    assert dupe.status_code == 409

    short = await client.post(
        "/admin/researchers",
        json={"email": "x@a04.test", "password": "short"},
        headers=admin_headers,
    )
    assert short.status_code == 400
    assert "12 characters" in short.json()["detail"]

    bad = await client.post(
        "/admin/researchers", json={"email": "nobody", "password": PASSWORD}, headers=admin_headers
    )
    assert bad.status_code == 400
    assert len((await client.get("/admin/researchers", headers=admin_headers)).json()) == 1


async def test_a_reset_password_ends_the_old_sessions(client, admin_headers):
    rid, theirs = await _colleague(client, admin_headers)
    assert (await client.get("/admin/researchers", headers=theirs)).status_code == 200

    reset = await client.post(
        f"/admin/researchers/{rid}/password",
        json={"password": "another-long-password"},
        headers=admin_headers,
    )
    assert reset.status_code == 200

    assert (await client.get("/admin/researchers", headers=theirs)).status_code == 401
    assert (await _login(client, "colleague@a04.test", PASSWORD)).status_code == 401
    assert (await _login(client, "colleague@a04.test", "another-long-password")).status_code == 200

    too_short = await client.post(
        f"/admin/researchers/{rid}/password", json={"password": "short"}, headers=admin_headers
    )
    assert too_short.status_code == 400


async def test_revoking_signs_the_account_out_but_keeps_its_password(client, admin_headers):
    rid, theirs = await _colleague(client, admin_headers)

    r = await client.post(f"/admin/researchers/{rid}/revoke", headers=admin_headers)
    assert r.status_code == 200

    assert (await client.get("/admin/researchers", headers=theirs)).status_code == 401
    assert (await _login(client, "colleague@a04.test", PASSWORD)).status_code == 200


async def test_changing_own_password_asks_for_the_old_one_and_keeps_the_admin_signed_in(
    client, admin_headers
):
    wrong = await client.post(
        "/admin/me/password",
        json={"current_password": "not-it", "new_password": "a-brand-new-password"},
        headers=admin_headers,
    )
    assert wrong.status_code == 400
    assert (await client.get("/admin/researchers", headers=admin_headers)).status_code == 200

    r = await client.post(
        "/admin/me/password",
        json={"current_password": "testpassword12", "new_password": "a-brand-new-password"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    fresh = {"Authorization": f"Bearer {r.json()['access_token']}"}
    # The old session is over, the handed-back token carries on.
    assert (await client.get("/admin/researchers", headers=admin_headers)).status_code == 401
    assert (await client.get("/admin/researchers", headers=fresh)).status_code == 200
    assert (await _login(client, "researcher@a04.test", "a-brand-new-password")).status_code == 200
    assert (await _login(client, "researcher@a04.test", "testpassword12")).status_code == 401


async def test_unknown_accounts_are_404_and_strangers_are_401(client, admin_headers):
    r = await client.post(
        "/admin/researchers/9999/password", json={"password": PASSWORD}, headers=admin_headers
    )
    assert r.status_code == 404
    assert (
        await client.post("/admin/researchers/9999/revoke", headers=admin_headers)
    ).status_code == 404
    assert (await client.get("/admin/researchers")).status_code == 401
