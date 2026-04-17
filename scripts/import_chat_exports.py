#!/usr/bin/env python3
"""Import WhatsApp chat exports for recovery after the 2026-04-17 ban.

Usage:
  python scripts/import_chat_exports.py
  python scripts/import_chat_exports.py --dir recovery_exports --dry-run
  python scripts/import_chat_exports.py --file recovery_exports/972544848291_Noam.txt

Filename convention (REQUIRED — we can't recover phone from export body):
    {phone_digits_only}_{DisplayName}.txt

  Examples:
    972544848291_Noam.txt
    972523955056_Daniel-Cohen.txt
    972501234567.txt                 (display name optional)

Files that don't match are skipped with a loud error.

What this script does per export file:
  1. Parse lines: [DD.MM.YYYY, HH:MM:SS] Sender Name: message body
     (also handles DD/MM/YYYY, 2-digit year, no-seconds, multiline bodies)
  2. Ensure household + whatsapp_member_mapping + onboarding_conversations
     rows exist (idempotent on (phone_number)).
  3. Deduplicate every message via synthetic ID derived from
     (sender_phone, ISO timestamp, message body).
  4. Insert inbound user messages with classification='backlog_imported_user'.
  5. Insert bot (outbound) messages with classification='manual_reply_imported'
     and sender_phone = BOT_PHONE.
  6. Haiku-classify every inbound user message; store classification_data.
  7. For actionable intents, create REAL rows in tasks / shopping_items /
     events / expenses / reminder_queue so they appear in the app for the
     user. Past reminders get fired_at = scheduled_for, status='fired'.
  8. Decide whether Yaron's manual reply already resolved the ask:
     the onboarding_conversations.context is stamped with either
     recovery_state='handled_manually' or 'needs_recovery'.

Idempotent — re-running on the same files is a no-op.
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    BOT_NAMES, BOT_PHONE, haiku_classify, make_import_msg_id,
    message_already_imported, rand_id, sb_get, sb_patch, sb_post,
)

IL_TZ = timezone(timedelta(hours=3))  # IDT. UTC+3 close enough for recovery timestamps.

# ─── Parsing ────────────────────────────────────────────────────────────────

# [17.04.2026, 07:22:14] Name: body
# [17.4.26, 7:22] Name: body
# [17/04/2026, 07:22:14] Name: body
LINE_RE = re.compile(
    r"^\[(?P<d>\d{1,2})[./](?P<m>\d{1,2})[./](?P<y>\d{2,4}),\s*"
    r"(?P<H>\d{1,2}):(?P<M>\d{2})(?::(?P<S>\d{2}))?\]\s+"
    r"(?P<sender>[^:]+?):\s?(?P<body>.*)$"
)

# {phone}_{name}.txt  or  {phone}.txt
FILENAME_RE = re.compile(r"^(?P<phone>\d{9,15})(?:_(?P<name>.+))?\.txt$")


def parse_timestamp(d: str, m: str, y: str, H: str, M: str, S: str | None) -> datetime:
    year = int(y)
    if year < 100:
        year += 2000
    sec = int(S) if S else 0
    return datetime(year, int(m), int(d), int(H), int(M), sec, tzinfo=IL_TZ)


def parse_export(path: Path) -> list[dict]:
    """Return list of {sender, ts, text, raw_ts_iso}."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    messages: list[dict] = []
    current: dict | None = None
    for line in raw.splitlines():
        m = LINE_RE.match(line)
        if m:
            if current:
                messages.append(current)
            ts = parse_timestamp(m["d"], m["m"], m["y"], m["H"], m["M"], m["S"])
            current = {
                "sender": m["sender"].strip(),
                "ts": ts,
                "text": m["body"],
                "raw_ts_iso": ts.astimezone(timezone.utc).isoformat(),
            }
        else:
            if current is not None:
                # Continuation of a multiline body; preserve newline.
                current["text"] = (current["text"] + "\n" + line).strip("\n")
    if current:
        messages.append(current)
    return messages


def is_bot(sender: str) -> bool:
    s = sender.strip().lower()
    return sender in BOT_NAMES or s in {"sheli", "שלי", "shelly", "shelley"}


# ─── DB operations ──────────────────────────────────────────────────────────

def find_or_create_household(phone: str, display_name: str | None,
                             first_msg_ts_iso: str) -> tuple[str, bool]:
    """Returns (household_id, created_flag)."""
    existing = sb_get(
        "whatsapp_member_mapping",
        {"phone_number": f"eq.{phone}", "select": "household_id", "limit": "1"},
    )
    if existing:
        return existing[0]["household_id"], False

    hh_id = rand_id("hh_")
    name = (display_name or "משפחה").strip()
    sb_post("households_v2", {
        "id": hh_id,
        "name": f"{name} (recovered)",
        "lang": "he",
    })
    sb_post("whatsapp_member_mapping", {
        "household_id": hh_id,
        "phone_number": phone,
        "member_name": name or "User",
    })
    sb_post("household_members", {
        "household_id": hh_id,
        "display_name": name or "User",
    })
    return hh_id, True


def ensure_onboarding(phone: str, household_id: str, display_name: str,
                       msg_count: int, ctx_patch: dict[str, Any]) -> None:
    existing = sb_get(
        "onboarding_conversations",
        {"phone": f"eq.{phone}", "select": "id,context", "limit": "1"},
    )
    if existing:
        current_ctx = existing[0].get("context") or {}
        merged = {**current_ctx, **ctx_patch, "name": display_name or current_ctx.get("name")}
        sb_patch(
            "onboarding_conversations",
            {"phone": phone},
            {
                "household_id": household_id,
                "state": "chatting",
                "message_count": max(msg_count, int(current_ctx.get("message_count", 0) or 0)),
                "context": merged,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    else:
        sb_post("onboarding_conversations", {
            "phone": phone,
            "household_id": household_id,
            "state": "chatting",
            "message_count": msg_count,
            "context": {"name": display_name, **ctx_patch},
            "tried_capabilities": [],
        })


def insert_message(household_id: str, phone: str, sender_name: str, text: str,
                   ts_iso: str, classification: str,
                   classification_data: dict | None) -> bool:
    """Returns True if inserted, False if already existed."""
    msg_id = make_import_msg_id(phone, ts_iso, text)
    if message_already_imported(msg_id):
        return False
    sb_post("whatsapp_messages", {
        "household_id": household_id,
        "group_id": f"{phone}@s.whatsapp.net",
        "sender_phone": phone,
        "sender_name": sender_name,
        "message_text": text,
        "message_type": "text",
        "whatsapp_message_id": msg_id,
        "classification": classification,
        "classification_data": classification_data,
        "created_at": ts_iso,
    })
    return True


# ─── Action materialization ─────────────────────────────────────────────────

def materialize_actions(household_id: str, cls: dict, text: str, ts_iso: str,
                        user_name: str) -> list[str]:
    """Create real CMS rows for an actionable classification.
    Returns list of table names written to (for logging).
    Conservative: only acts on high-confidence (>=0.6) actionable intents.
    Deduped by content + household so re-runs are safe.
    """
    intent = cls.get("intent")
    conf = float(cls.get("confidence") or 0)
    entities = cls.get("entities") or {}
    if conf < 0.6 or intent in (None, "ignore", "question", "recall_memory"):
        return []
    touched: list[str] = []

    if intent == "add_shopping":
        items = entities.get("items") or []
        if isinstance(items, str):
            items = [items]
        for raw_item in items:
            name = str(raw_item).strip()
            if not name:
                continue
            existing = sb_get("shopping_items", {
                "household_id": f"eq.{household_id}",
                "name": f"eq.{name}",
                "got": "eq.false",
                "select": "id", "limit": "1",
            })
            if existing:
                continue
            sb_post("shopping_items", {
                "id": rand_id("sh"),
                "household_id": household_id,
                "name": name,
                "got": False,
                "created_at": ts_iso,
            })
            touched.append("shopping_items")
        return touched

    if intent == "add_task":
        title = (entities.get("text") or text).strip()[:200]
        if not title:
            return []
        existing = sb_get("tasks", {
            "household_id": f"eq.{household_id}",
            "title": f"eq.{title}",
            "done": "eq.false",
            "select": "id", "limit": "1",
        })
        if existing:
            return []
        sb_post("tasks", {
            "id": rand_id("tk"),
            "household_id": household_id,
            "title": title,
            "assigned_to": entities.get("assigned_to"),
            "done": False,
            "created_at": ts_iso,
        })
        touched.append("tasks")
        return touched

    if intent == "add_event":
        title = (entities.get("text") or text).strip()[:200]
        scheduled = entities.get("time_iso") or ts_iso
        existing = sb_get("events", {
            "household_id": f"eq.{household_id}",
            "title": f"eq.{title}",
            "scheduled_for": f"eq.{scheduled}",
            "select": "id", "limit": "1",
        })
        if existing:
            return []
        sb_post("events", {
            "id": rand_id("ev"),
            "household_id": household_id,
            "title": title,
            "scheduled_for": scheduled,
            "assigned_to": entities.get("assigned_to"),
            "created_at": ts_iso,
        })
        touched.append("events")
        return touched

    if intent == "add_reminder":
        reminder_text = (entities.get("text") or text).strip()[:500]
        send_at = entities.get("time_iso") or ts_iso
        now_iso = datetime.now(timezone.utc).isoformat()
        is_past = send_at < now_iso
        existing = sb_get("reminder_queue", {
            "household_id": f"eq.{household_id}",
            "message_text": f"eq.{reminder_text}",
            "scheduled_for": f"eq.{send_at}",
            "select": "id", "limit": "1",
        })
        if existing:
            return []
        row: dict[str, Any] = {
            "id": rand_id("rm"),
            "household_id": household_id,
            "message_text": reminder_text,
            "scheduled_for": send_at,
            "status": "fired" if is_past else "pending",
            "created_at": ts_iso,
        }
        if is_past:
            row["fired_at"] = send_at
        sb_post("reminder_queue", row)
        touched.append("reminder_queue")
        return touched

    if intent == "add_expense":
        amount = entities.get("amount")
        currency = (entities.get("currency") or "ILS").upper()
        description = (entities.get("description") or text).strip()[:200]
        if amount is None:
            return []
        try:
            amount_minor = int(round(float(amount) * 100))
        except (TypeError, ValueError):
            return []
        existing = sb_get("expenses", {
            "household_id": f"eq.{household_id}",
            "description": f"eq.{description}",
            "amount_minor": f"eq.{amount_minor}",
            "occurred_at": f"eq.{ts_iso}",
            "select": "id", "limit": "1",
        })
        if existing:
            return []
        sb_post("expenses", {
            "id": rand_id("ex"),
            "household_id": household_id,
            "amount_minor": amount_minor,
            "currency": currency,
            "description": description,
            "paid_by": user_name,
            "attribution": "speaker",
            "occurred_at": ts_iso,
            "visibility": "private",
            "source": "recovered_import",
            "logged_by_phone": None,
        })
        touched.append("expenses")
        return touched

    if intent == "complete_shopping":
        items = entities.get("items") or []
        if isinstance(items, str):
            items = [items]
        for raw_item in items:
            name = str(raw_item).strip()
            if not name:
                continue
            sb_patch(
                "shopping_items",
                {"household_id": household_id, "name": name, "got": "false"},
                {"got": True, "got_at": ts_iso, "got_by": user_name},
            )
        return ["shopping_items"] if items else []

    return []


# ─── Manual-reply resolution heuristic ──────────────────────────────────────

RESOLVED_MARKERS = (
    "הוספתי", "רשמתי", "עשיתי", "בוצע", "סומן", "שמרתי", "יאללה",
    "אני על זה", "הנה", "על זה", "סידרתי", "תזכורת נוצרה", "נרשם",
)


def classify_recovery_state(parsed_msgs: list[dict]) -> str:
    """Return 'handled_manually', 'needs_recovery', or 'noise_only'."""
    last_user_idx = -1
    for i, m in enumerate(parsed_msgs):
        if not is_bot(m["sender"]):
            last_user_idx = i
    if last_user_idx < 0:
        return "noise_only"

    # Any inbound actionable content at all?
    has_actionable = any(
        not is_bot(m["sender"]) and len(m["text"].strip()) > 3
        for m in parsed_msgs
    )
    if not has_actionable:
        return "noise_only"

    # Was there a bot/manual reply AFTER the user's last message?
    post_reply = [m for m in parsed_msgs[last_user_idx + 1:] if is_bot(m["sender"])]
    if not post_reply:
        return "needs_recovery"

    last_bot_text = post_reply[-1]["text"]
    if any(mark in last_bot_text for mark in RESOLVED_MARKERS):
        return "handled_manually"
    # Bot replied but with something uninformative (sticker/emoji/etc).
    return "needs_recovery"


# ─── File-level driver ─────────────────────────────────────────────────────

def process_file(path: Path, dry_run: bool = False) -> dict:
    fname = path.name
    m = FILENAME_RE.match(fname)
    if not m:
        print(f"  SKIP: filename {fname!r} does not match {{phone}}_{{name}}.txt", file=sys.stderr)
        return {"file": fname, "status": "skipped_bad_filename"}
    phone = m["phone"]
    display_name = (m["name"] or "").replace("-", " ").strip() or "User"

    parsed = parse_export(path)
    if not parsed:
        print(f"  SKIP: {fname} parsed 0 messages", file=sys.stderr)
        return {"file": fname, "status": "skipped_empty", "phone": phone}

    user_msgs = [m for m in parsed if not is_bot(m["sender"])]
    bot_msgs = [m for m in parsed if is_bot(m["sender"])]
    first_ts = parsed[0]["raw_ts_iso"]
    recovery_state = classify_recovery_state(parsed)

    if dry_run:
        print(f"  DRY {fname}: phone={phone} name={display_name} "
              f"total={len(parsed)} user={len(user_msgs)} bot={len(bot_msgs)} "
              f"state={recovery_state}")
        return {"file": fname, "status": "dry", "phone": phone,
                "total_messages": len(parsed), "recovery_state": recovery_state}

    hh_id, created = find_or_create_household(phone, display_name, first_ts)
    ensure_onboarding(phone, hh_id, display_name, msg_count=len(user_msgs),
                      ctx_patch={"recovery_state": recovery_state, "recovered_from_export": True})

    inserted_in = 0
    inserted_out = 0
    classifications: list[dict] = []
    actions_created: dict[str, int] = {}

    for msg in parsed:
        ts_iso = msg["raw_ts_iso"]
        text = msg["text"]
        sender = msg["sender"]
        if is_bot(sender):
            ok = insert_message(hh_id, BOT_PHONE, "שלי", text, ts_iso,
                                "manual_reply_imported", None)
            if ok:
                inserted_out += 1
        else:
            cls = haiku_classify(text, display_name)
            ok = insert_message(hh_id, phone, display_name, text, ts_iso,
                                "backlog_imported_user", cls)
            if ok:
                inserted_in += 1
                classifications.append({"text": text, "cls": cls, "ts_iso": ts_iso})
                touched = materialize_actions(hh_id, cls, text, ts_iso, display_name)
                for t in touched:
                    actions_created[t] = actions_created.get(t, 0) + 1

    print(f"  {fname}: phone={phone} hh={hh_id}{' [new]' if created else ''} "
          f"in={inserted_in} out={inserted_out} state={recovery_state} "
          f"actions={actions_created or '-'}")

    return {
        "file": fname,
        "status": "ok",
        "phone": phone,
        "household_id": hh_id,
        "created_household": created,
        "inserted_inbound": inserted_in,
        "inserted_outbound": inserted_out,
        "recovery_state": recovery_state,
        "actions": actions_created,
    }


# ─── CLI ────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="Import WhatsApp chat exports for recovery.")
    p.add_argument("--dir", default="recovery_exports",
                   help="directory containing .txt exports (default: recovery_exports)")
    p.add_argument("--file", help="single export file to import (overrides --dir)")
    p.add_argument("--dry-run", action="store_true",
                   help="parse and report but don't write to DB or call Haiku")
    args = p.parse_args()

    if args.file:
        paths = [Path(args.file)]
    else:
        d = Path(args.dir)
        if not d.exists():
            print(f"No {args.dir}/ — nothing to import. Drop .txt exports there first.")
            return 0
        paths = sorted(d.glob("*.txt"))

    if not paths:
        print(f"No .txt files found under {args.dir}/.")
        return 0

    print(f"Processing {len(paths)} export file(s)...")
    summary: list[dict] = []
    for p_path in paths:
        try:
            summary.append(process_file(p_path, dry_run=args.dry_run))
        except Exception as e:
            print(f"  ERROR on {p_path.name}: {e}", file=sys.stderr)
            summary.append({"file": p_path.name, "status": "error", "error": str(e)})

    total_in = sum(s.get("inserted_inbound", 0) for s in summary)
    total_out = sum(s.get("inserted_outbound", 0) for s in summary)
    households_new = sum(1 for s in summary if s.get("created_household"))
    needs_recovery = sum(1 for s in summary if s.get("recovery_state") == "needs_recovery")
    print("")
    print(f"Done. files={len(summary)} new_households={households_new} "
          f"inbound={total_in} outbound={total_out} needs_recovery={needs_recovery}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
