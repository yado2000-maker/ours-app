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
  - 1:1 chats:
      * inbound (from_me=false)  -> classification='backlog_imported_user'
                                    + Haiku classification_data
      * outbound (from_me=true)  -> classification='manual_reply_imported'
  - Group chats (chat_id ending @g.us):
      * Looked up via whatsapp_config → household_id. Unmapped groups are
        logged and stored with household_id='unknown' for later linkage.
      * Same classification labels as 1:1. Inbound messages get a
        classification_data.recovery_state tag ('handled'/'needs_recovery'/
        'low_intent') computed once the batch has all messages (two-pass).
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
from import_chat_exports import (  # noqa: E402
    is_low_intent, reply_resolves_ask,
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


def household_for_group(group_jid: str) -> str | None:
    """Look up household by Whapi group JID (e.g. 12036305xxxx-1590xxxxxx@g.us)."""
    rows = sb_get(
        "whatsapp_config",
        {"group_id": f"eq.{group_jid}", "select": "household_id", "limit": "1"},
    )
    if rows:
        return rows[0].get("household_id")
    return None


def _extract_text(msg: dict) -> str:
    text_obj = msg.get("text") or {}
    text = text_obj.get("body") if isinstance(text_obj, dict) else str(text_obj or "")
    if not text:
        text = msg.get("caption") or ""
    return (text or "").strip()


def normalize_whapi_message(msg: dict) -> dict | None:
    """Return {wa_id, chat_id, is_group, phone, from_me, sender_name, text, ts_iso}
    or None if the message should be skipped."""
    wa_id = msg.get("id") or msg.get("_id")
    if not wa_id:
        return None
    if msg.get("type") not in (None, "text", "voice", "ptt", "audio", "image", "document"):
        return None
    chat_id: str = msg.get("chat_id") or msg.get("from") or ""
    is_group = chat_id.endswith("@g.us")
    phone = (msg.get("from") or chat_id).split("@")[0]
    from_me = bool(msg.get("from_me"))
    text = _extract_text(msg)
    if not text:
        return None
    ts_unix = msg.get("timestamp") or 0
    ts_iso = (datetime.fromtimestamp(int(ts_unix), tz=timezone.utc).isoformat()
              if ts_unix else datetime.now(timezone.utc).isoformat())
    return {
        "wa_id": wa_id,
        "chat_id": chat_id,
        "is_group": is_group,
        "phone": phone,
        "from_me": from_me,
        "sender_name": msg.get("from_name") or "משתמש",
        "text": text,
        "ts_iso": ts_iso,
    }


def _resolve_group_backlog(group_msgs: list[dict], use_llm: bool) -> None:
    """Annotate each inbound message dict with 'recovery_state' and, if
    low_intent, a tentative classification.

    group_msgs: chronological list of normalized messages from ONE group.
    Mutates in place. Expects each msg to already carry classification_data
    (for inbound) via an earlier Haiku pass.
    """
    from datetime import datetime as _dt
    n = len(group_msgs)
    ts_parsed: list[datetime] = []
    for m in group_msgs:
        try:
            ts_parsed.append(_dt.fromisoformat(m["ts_iso"].replace("Z", "+00:00")))
        except Exception:
            ts_parsed.append(datetime.now(timezone.utc))
    for i, m in enumerate(group_msgs):
        if m["from_me"]:
            continue
        cls = m.get("classification_data") or {}
        if is_low_intent(m["text"], cls):
            m["recovery_state"] = "low_intent"
            continue
        next_reply: dict | None = None
        for j in range(i + 1, n):
            if group_msgs[j]["from_me"]:
                delta = (ts_parsed[j] - ts_parsed[i]).total_seconds()
                if delta <= 30 * 60:
                    next_reply = group_msgs[j]
                break
        if not next_reply:
            m["recovery_state"] = "needs_recovery"
            continue
        m["recovery_state"] = (
            "handled" if reply_resolves_ask(m["text"], next_reply["text"], use_llm=use_llm)
            else "needs_recovery"
        )


def import_batch(messages: list[dict], dry_run: bool = False) -> dict[str, int]:
    """Normalize → Haiku-classify inbound → compute group resolution → insert.
    Returns counter dict.
    """
    totals: dict[str, int] = {}
    normalized: list[dict] = []
    for msg in messages:
        n = normalize_whapi_message(msg)
        if n is None:
            totals["skip_non_text"] = totals.get("skip_non_text", 0) + 1
            continue
        if message_already_imported(n["wa_id"]):
            totals["dup"] = totals.get("dup", 0) + 1
            continue
        # Haiku-classify inbound text (1:1 AND group).
        if not n["from_me"]:
            n["classification_data"] = (haiku_classify(n["text"], n["sender_name"])
                                        if not dry_run else None)
        normalized.append(n)

    # Group messages by chat_id for per-group resolution tracking.
    by_chat: dict[str, list[dict]] = {}
    for n in normalized:
        by_chat.setdefault(n["chat_id"], []).append(n)
    for chat_id, chat_msgs in by_chat.items():
        if chat_msgs and chat_msgs[0]["is_group"]:
            chat_msgs.sort(key=lambda x: x["ts_iso"])
            _resolve_group_backlog(chat_msgs, use_llm=not dry_run)

    # Now insert (flat iteration).
    for n in normalized:
        if dry_run:
            totals["inserted"] = totals.get("inserted", 0) + 1
            continue
        if n["is_group"]:
            household_id = household_for_group(n["chat_id"]) or "unknown"
        else:
            household_id = household_for_phone(n["phone"]) or "unknown"
        if n["from_me"]:
            sender_phone = BOT_PHONE
            sender_name = "שלי"
            classification = "manual_reply_imported"
            cls_data = None
        else:
            sender_phone = n["phone"]
            sender_name = n["sender_name"]
            classification = "backlog_imported_user"
            cls_data = n.get("classification_data") or {}
            if "recovery_state" in n:
                cls_data = {**cls_data, "recovery_state": n["recovery_state"]}
        try:
            sb_post("whatsapp_messages", {
                "household_id": household_id,
                "group_id": n["chat_id"],
                "sender_phone": sender_phone,
                "sender_name": sender_name,
                "message_text": n["text"],
                "message_type": "text",
                "whatsapp_message_id": n["wa_id"],
                "classification": classification,
                "classification_data": cls_data,
                "created_at": n["ts_iso"],
            })
            totals["inserted"] = totals.get("inserted", 0) + 1
        except Exception as e:
            print(f"    error on {n['wa_id']}: {e}", file=sys.stderr)
            totals["error"] = totals.get("error", 0) + 1
    return totals


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

    # Collect all pages first so group resolution can see the full thread
    # at once (resolution requires chronological context across pages).
    offset = 0
    all_messages: list[dict] = []
    while True:
        batch = list_messages(args.since, offset=offset, count=100)
        if not batch:
            break
        print(f"  page offset={offset} size={len(batch)}")
        all_messages.extend(batch)
        if len(batch) < 100:
            break
        offset += 100
    print(f"  collected {len(all_messages)} raw messages")

    totals = import_batch(all_messages, dry_run=args.dry_run)

    print("")
    print(f"Done. { {k: v for k, v in sorted(totals.items())} }")
    return 0


if __name__ == "__main__":
    sys.exit(main())
