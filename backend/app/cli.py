"""Operator commands. Run from the backend directory with DATABASE_URL set:

    python -m app.cli create-admin --email you@uni.example --name "Your Name"
    python -m app.cli list-admins
    python -m app.cli reset-password --email you@uni.example
    python -m app.cli revoke-sessions --email you@uni.example
    python -m app.cli seed-questionnaires --study-id 3

Without --password the command prompts for one (twice, hidden), so credentials
stay out of the shell history.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from getpass import getpass

from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.models.researcher import Researcher
from app.models.study import Study
from app.services.researchers import (
    ProvisioningError,
    create_researcher,
    revoke_researcher_sessions,
    set_researcher_password,
)
from app.services.study_content import seed_batteries


def _read_password(given: str | None) -> str:
    if given:
        return given
    if not sys.stdin.isatty():
        raise ProvisioningError("No --password given and stdin is not a terminal.")
    first = getpass("Password: ")
    if first != getpass("Repeat password: "):
        raise ProvisioningError("The two passwords differ.")
    return first


async def _create_admin(args: argparse.Namespace) -> None:
    password = _read_password(args.password)
    async with SessionLocal() as db:
        researcher = await create_researcher(db, args.email, password, args.name)
    print(f"Created researcher {researcher.email} (id {researcher.id}).")


async def _reset_password(args: argparse.Namespace) -> None:
    password = _read_password(args.password)
    async with SessionLocal() as db:
        researcher = await set_researcher_password(db, args.email, password)
    print(f"Password updated for {researcher.email}.")


async def _revoke_sessions(args: argparse.Namespace) -> None:
    async with SessionLocal() as db:
        researcher = await revoke_researcher_sessions(db, args.email)
    print(f"Signed {researcher.email} out of every session.")


async def _list_admins(_: argparse.Namespace) -> None:
    async with SessionLocal() as db:
        rows = (await db.execute(select(Researcher).order_by(Researcher.id))).scalars().all()
    if not rows:
        print("No researchers yet. Create one with `create-admin`.")
        return
    for r in rows:
        print(f"{r.id:>4}  {r.email}  {r.name or '—'}")


async def _seed_questionnaires(args: argparse.Namespace) -> None:
    async with SessionLocal() as db:
        study = await db.get(Study, args.study_id)
        if study is None:
            raise ProvisioningError(f"No study with id {args.study_id}.")
        created = await seed_batteries(db, study.id)
        await db.commit()

    if not created:
        print(f"{study.name} already has every standard battery.")
        return
    for q in created:
        print(f"  + {q.placement.value:<11} {q.title} ({len(q.questions)} question(s))")
    print(f"Added {len(created)} questionnaire(s) to {study.name}.")


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m app.cli", description="A04 operator commands")
    subs = ap.add_subparsers(dest="command", required=True)

    create = subs.add_parser("create-admin", help="create a researcher account")
    create.add_argument("--email", required=True)
    create.add_argument("--name", default="")
    create.add_argument("--password", help="prompted for if omitted")
    create.set_defaults(run=_create_admin)

    reset = subs.add_parser("reset-password", help="change a researcher's password")
    reset.add_argument("--email", required=True)
    reset.add_argument("--password", help="prompted for if omitted")
    reset.set_defaults(run=_reset_password)

    revoke = subs.add_parser("revoke-sessions", help="invalidate a researcher's existing tokens")
    revoke.add_argument("--email", required=True)
    revoke.set_defaults(run=_revoke_sessions)

    listing = subs.add_parser("list-admins", help="show existing researcher accounts")
    listing.set_defaults(run=_list_admins)

    # New studies get these on creation; this is for the ones made before.
    seed = subs.add_parser(
        "seed-questionnaires", help="give a study the standard batteries it is missing"
    )
    seed.add_argument("--study-id", type=int, required=True)
    seed.set_defaults(run=_seed_questionnaires)

    return ap


def main() -> None:
    args = _parser().parse_args()

    async def run() -> None:
        try:
            await args.run(args)
        finally:
            await engine.dispose()

    try:
        asyncio.run(run())
    except ProvisioningError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
