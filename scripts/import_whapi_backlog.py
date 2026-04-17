#!/usr/bin/env python3
"""Import Whapi message backlog from the 2026-04-17 ban window.

Usage:
  python scripts/import_whapi_backlog.py
  python scripts/import_whapi_backlog.py --since 1776404520   (unix seconds UTC)
  python scripts/import_whapi_backlog.py --dry-run

Exits cleanly with "Whapi in QR state" if the bot's WhatsApp channel is
unpaired (which is exactly the situation right now — ban unpaired the
linked device; re-pair must happen first). Never crashes.

What it does when Whapi is AUTH'd:
  - Paginates GET /messages/list?time_from=<ts> (Whapi caps at 100/page).
  - For each message:
      * inbound (from_me=false)  -> classification='backlog_imported_user'
                                    + Haiku classification_data
      * outbound (from_me=true)  -> classification='manual_reply_imported'
  - Dedupes on whatsapp_message_id (Whapi gives real IDs, unlike exports).

Does NOT materialize action rows (tasks/shopping/etc). Leave that to
import_chat_exports.py which has richer thread context; the Whapi backlog
is an augmentation, not a replacement.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    BOT_PHONE, WHAPI_TOKEN, haiku_classify, message_already_imported,
    requests, sb_get, sb_post,
)

# Webhook went silent when the ban hit (2026-04-17 ~05:42 UTC).
DEFAULT_SINCE = 1776404520


def check_whapi_health() -> dict:
    r = requests.get(
        "https://gate.whapi.cloud/health",
        headers={"Authorization": f"Bearer {WHAPI_TOKEN}"},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def list_messages(since_unix: int, offset: int = 0, count: int = 100) -> list[dict]:
    r = requests.get(
        "https://gate.whapi.cloud/messages/list",
        headers={"Authorization": f"Bearer {WHAPI_TOKEN}"},
        params={"time_from": since_unix, "count": count, "offset": offset},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    # Whapi returns {"messages": [...]} OR {"count": N, "messages": [...]}
    return data.get("messages") or []


def household_for_phone(phone: str) -> str | None:
    rows = sb_get(
        "whatsapp_member_mapping",
        {"phone_number": f"eq.{phone}", "select": "household_id", "limit": "1"},
    )
    if rows:
        return rows[0]["household_id"]
    # Fall back: check onboarding_conversations (1:1 users without group mapping).
    rows = sb_get(
        "onboarding_conversations",
        {"phone": f"eq.{phone}", "select": "household_id", "limit": "1"},
    )
    if rows and rows[0].get("household_id"):
        return rows[0]["household_id"]
    return None


def import_message(msg: dict, dry_run: bool = False) -> str:
    """Returns status code: 'inserted', 'dup', 'skip_no_id', 'skip_non_text'."""
    wa_id = msg.get("id") or msg.get("_id")
    if not wa_id:
        return "skip_no_id"
    if msg.get("type") not in (None, "text", "voice", "ptt", "audio", "image", "document"):
        return "skip_non_text"

    # Whapi chat_id shape: "{phone}@s.whatsapp.net" (1:1) or "{id}@g.us" (group).
    chat_id: str = msg.get("chat_id") or msg.get("from") or ""
    if chat_id.endswith("@g.us"):
        # Groups already handled live via webhook; skip here to stay in scope.
        return "skip_non_text"
    phone = (msg.get("from") or chat_id).split("@")[0]
    from_me = bool(msg.get("from_me"))
    text_obj = msg.get("text") or {}
    text = text_obj.get("body") if isinstance(text_obj, dict) else str(text_obj or "")
    if not text:
        text = msg.get("caption") or ""
    text = (text or "").strip()
    if not text:
        return "skip_non_text"

    ts_unix = msg.get("timestamp") or 0
    ts_iso = datetime.fromtimestamp(int(ts_unix), tz=timezone.utc).isoformat() if ts_unix else datetime.now(timezone.utc).isoformat()

    if message_already_imported(wa_id):
        return "dup"

    household_id = household_for_phone(phone) or "unknown"
    if from_me:
        sender_phone = BOT_PHONE
        sender_name = "שלי"
        classification = "manual_reply_imported"
        cls_data = None
    else:
        sender_phone = phone
        sender_name = msg.get("from_name") or "משתמש"
        classification = "backlog_imported_user"
        cls_data = haiku_classify(text, sender_name) if not dry_run else None

    if dry_run:
        return "inserted"

    sb_post("whatsapp_messages", {
        "household_id": household_id,
        "group_id": chat_id,
        "sender_phone": sender_phone,
        "sender_name": sender_name,
        "message_text": text,
        "message_type": "text",
        "whatsapp_message_id": wa_id,
        "classification": classification,
        "classification_data": cls_data,
        "created_at": ts_iso,
    })
    return "inserted"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--since", type=int, default=DEFAULT_SINCE,
                   help=f"unix UTC seconds (default: {DEFAULT_SINCE} = 2026-04-17 05:42 UTC)")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    try:
        health = check_whapi_health()
    except Exception as e:
        print(f"ERROR: Whapi /health call failed: {e}", file=sys.stderr)
        return 2

    status_text = ((health.get("status") or {}).get("text") or "").upper()
    if status_text != "AUTH":
        print(f"Whapi in {status_text or 'UNKNOWN'} state — skipping backlog import.")
        print("Re-pair the bot phone via Whapi dashboard QR, then retry.")
        return 0

    print(f"Whapi AUTH ok. Importing since unix={args.since} "
          f"({datetime.fromtimestamp(args.since, tz=timezone.utc).isoformat()})")

    offset = 0
    totals: dict[str, int] = {}
    while True:
        batch = list_messages(args.since, offset=offset, count=100)
        if not batch:
            break
        print(f"  page offset={offset} size={len(batch)}")
        for msg in batch:
            try:
                status = import_message(msg, dry_run=args.dry_run)
            except Exception as e:
                print(f"    error on {msg.get('id')}: {e}", file=sys.stderr)
                status = "error"
            totals[status] = totals.get(status, 0) + 1
        if len(batch) < 100:
            break
        offset += 100

    print("")
    print(f"Done. { {k: v for k, v in sorted(totals.items())} }")
    return 0


if __name__ == "__main__":
    sys.exit(main())
