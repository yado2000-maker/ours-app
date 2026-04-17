#!/usr/bin/env python3
"""Import WhatsApp chat exports for recovery after the 2026-04-17 ban.

Usage:
  python scripts/import_chat_exports.py
  python scripts/import_chat_exports.py --dir recovery_exports --dry-run
  python scripts/import_chat_exports.py --file recovery_exports/972544848291_Noam.txt

Direct (1:1) files — filename convention (fallback when manifest is absent):
    {phone_digits_only}_{DisplayName}.txt
  Examples:
    972544848291_Noam.txt
    972523955056_Daniel-Cohen.txt
    972501234567.txt                 (display name optional)

Group files — ALWAYS require an entry in recovery_exports/manifest.json
(no way to infer group identity from filename). See manifest schema below.

manifest.json (optional, but required for groups):
  {
    "files": [
      {"path": "noam.txt",            "type": "direct", "phone": "972544848291", "display_name": "Noam"},
      {"path": "goldberg_family.txt", "type": "group",  "group_id": "<real JID>",  "existing_household_id": "hh_xxx", "group_name": "Goldberg Family"},
      {"path": "new_group.txt",       "type": "group",  "group_id": null,          "existing_household_id": null,   "group_name": "Some new group"}
    ]
  }

  - type=direct: overrides filename inference (useful when filename lacks phone)
  - type=group with existing_household_id: attach to that household, dedupe
  - type=group without existing_household_id: create new households_v2 with
      synthetic group_id "group_synthetic_<uuid>" + metadata flag
  - Files in the dir but missing from manifest: 1:1 uses filename inference,
      group files would be skipped (groups can't be inferred from filenames)

What this script does per export file:
  1. Parse lines: [DD.MM.YYYY, HH:MM:SS] Sender Name: message body
     (also handles DD/MM/YYYY, 2-digit year, no-seconds, multiline bodies)
     System messages ("X added Y", "encrypted", etc.) are skipped.
     The "~" prefix WhatsApp uses for unsaved contacts is stripped.
  2. Ensure household + member mappings + onboarding rows exist.
  3. Deduplicate every message via synthetic ID derived from
     (sender_phone or sender_name, ISO timestamp, message body).
  4. Insert inbound user messages with classification='backlog_imported_user'.
  5. Insert bot (outbound) messages with classification='manual_reply_imported'
     and sender_phone = BOT_PHONE.
  6. Haiku-classify every inbound user message; store classification_data
     with per-message `recovery_state`:
       - 'handled'         (followed by bot/manual reply that resolves the ask)
       - 'needs_recovery'  (no reply within 30 min, or reply didn't address it)
       - 'low_intent'      (ignore/noise/reaction — skip from recovery)
  7. For actionable intents in 1:1 chats, create real CMS rows so items
     appear in the app. Past reminders get fired_at = scheduled_for,
     status='fired'. Group actions are NOT materialised automatically —
     the recovery reply is unified and asks the group to re-confirm.
  8. Decide per-thread (1:1) or per-message (group) whether Yaron's manual
     reply resolved the ask; the planner consumes this to craft a single
     unified group recovery message vs. N one-on-one messages.

Idempotent — re-running on the same files is a no-op.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    BOT_NAMES, BOT_PHONE, haiku_classify, make_import_msg_id,
    message_already_imported, rand_id, sb_get, sb_patch, sb_post,
    sonnet_generate,
)

IL_TZ = timezone(timedelta(hours=3))  # IDT. UTC+3 close enough for recovery timestamps.

# ─── Parsing ────────────────────────────────────────────────────────────────

# [17.04.2026, 07:22:14] Name: body
# [17.4.26, 7:22] Name: body
# [17/04/2026, 07:22:14] Name: body
LINE_RE = re.compile(
    r"^\u200e?\[(?P<d>\d{1,2})[./](?P<m>\d{1,2})[./](?P<y>\d{2,4}),\s*"
    r"(?P<H>\d{1,2}):(?P<M>\d{2})(?::(?P<S>\d{2}))?\]\s+"
    r"(?P<sender>[^:]+?):\s?(?P<body>.*)$"
)

# Matches a line with a valid timestamp header but no "Sender: body" shape.
# These are WhatsApp system messages (group admin events, encryption notice,
# "X added Y", "X left", "X changed the subject"). We skip them entirely —
# without this check the default parser would append them as continuation
# lines onto the previous user message (latent corruption bug).
SYSTEM_HEAD_RE = re.compile(
    r"^\u200e?\[(?P<d>\d{1,2})[./](?P<m>\d{1,2})[./](?P<y>\d{2,4}),\s*"
    r"(?P<H>\d{1,2}):(?P<M>\d{2})(?::(?P<S>\d{2}))?\]\s+"
    r"(?P<rest>.*)$"
)

# {phone}_{name}.txt  or  {phone}.txt
FILENAME_RE = re.compile(r"^(?P<phone>\d{9,15})(?:_(?P<name>.+))?\.txt$")


def clean_sender(raw: str) -> str:
    """Strip WhatsApp's '~' prefix (used for unsaved contacts) and trim."""
    s = (raw or "").lstrip("\u200e").strip()
    # "~ שירה נדב" → "שירה נדב"; also "~שירה" → "שירה".
    if s.startswith("~"):
        s = s[1:].strip()
    return s


def parse_timestamp(d: str, m: str, y: str, H: str, M: str, S: str | None) -> datetime:
    year = int(y)
    if year < 100:
        year += 2000
    sec = int(S) if S else 0
    return datetime(year, int(m), int(d), int(H), int(M), sec, tzinfo=IL_TZ)


def parse_export(path: Path) -> list[dict]:
    """Return list of {sender, ts, text, raw_ts_iso}.

    Skips WhatsApp system messages (lines with a valid timestamp header but
    no "Sender: body" shape — e.g. "You added X", encryption notice). Strips
    the "~" prefix that WhatsApp prepends to unsaved-contact senders.

    Multi-line user messages are joined with "\\n" until the next timestamped
    line. System lines in the middle of a chat DO NOT count as continuation —
    they flush the current message and are dropped.
    """
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
                "sender": clean_sender(m["sender"]),
                "ts": ts,
                "text": m["body"],
                "raw_ts_iso": ts.astimezone(timezone.utc).isoformat(),
            }
            continue
        # New-timestamp-but-no-colon → system message. Flush + skip.
        if SYSTEM_HEAD_RE.match(line):
            if current:
                messages.append(current)
                current = None
            continue
        # Otherwise: continuation of previous message body.
        if current is not None:
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


# ─── Manifest loader ────────────────────────────────────────────────────────

def load_manifest(dir_path: Path) -> dict[str, dict]:
    """Read recovery_exports/manifest.json → {filename: entry}.
    Returns {} if no manifest file. Invalid manifest prints a warning but
    doesn't raise — 1:1 files fall back to filename inference.
    """
    mf = dir_path / "manifest.json"
    if not mf.exists():
        return {}
    try:
        data = json.loads(mf.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  WARN: bad manifest.json: {e} — continuing without it", file=sys.stderr)
        return {}
    out: dict[str, dict] = {}
    for entry in data.get("files", []) or []:
        p = entry.get("path")
        if not p:
            continue
        out[p] = entry
    return out


# ─── Group helpers ─────────────────────────────────────────────────────────

def synthetic_group_id() -> str:
    return f"group_synthetic_{uuid.uuid4().hex[:16]}"


def find_or_create_group_household(entry: dict) -> tuple[str, str, bool]:
    """Returns (household_id, group_id, created_flag).

    Rules (per manifest entry):
      - If existing_household_id set → use it; reuse group_id from that
        household's whatsapp_config if we have no better one.
      - Else → create new households_v2 + synthetic group_id +
        metadata {synthetic_group: true, awaiting_real_jid: <bool>}.
    """
    existing_hh = (entry.get("existing_household_id") or "").strip()
    real_jid = (entry.get("group_id") or "").strip() or None
    group_name = (entry.get("group_name") or "").strip() or "משפחה"

    if existing_hh:
        # Link to existing household; if caller provided a real_jid and the
        # household has no group_id yet, upsert into whatsapp_config.
        if real_jid:
            cfg = sb_get("whatsapp_config", {
                "household_id": f"eq.{existing_hh}",
                "select": "group_id", "limit": "1",
            })
            if not cfg or not (cfg[0] or {}).get("group_id"):
                sb_post("whatsapp_config", {
                    "household_id": existing_hh,
                    "group_id": real_jid,
                    "bot_active": True,
                }, upsert=True)
            return existing_hh, real_jid, False
        # No real_jid known — use whatever is on file, else a synthetic one.
        cfg = sb_get("whatsapp_config", {
            "household_id": f"eq.{existing_hh}",
            "select": "group_id", "limit": "1",
        })
        gid = (cfg[0].get("group_id") if cfg else None) or synthetic_group_id()
        return existing_hh, gid, False

    # Fresh household for a newly-discovered group.
    hh_id = rand_id("hh_")
    gid = real_jid or synthetic_group_id()
    sb_post("households_v2", {
        "id": hh_id,
        "name": f"{group_name} (recovered)",
        "lang": "he",
        "metadata": {
            "synthetic_group": not bool(real_jid),
            "awaiting_real_jid": not bool(real_jid),
            "recovered_from_export": True,
        },
    })
    sb_post("whatsapp_config", {
        "household_id": hh_id,
        "group_id": gid,
        "bot_active": True,
    }, upsert=True)
    return hh_id, gid, True


def match_member_phone(household_id: str, display_name: str) -> str | None:
    """Look up a phone number for a display name inside a household.
    Checks whatsapp_member_mapping (authoritative). Returns None if unknown
    — the member may be phone-less until a live message arrives.
    """
    if not display_name:
        return None
    rows = sb_get("whatsapp_member_mapping", {
        "household_id": f"eq.{household_id}",
        "member_name": f"eq.{display_name}",
        "select": "phone_number", "limit": "1",
    })
    if rows and rows[0].get("phone_number"):
        return rows[0]["phone_number"]
    # Soft match: household_members by display_name only (no phone).
    return None


def ensure_group_member(household_id: str, display_name: str,
                        phone: str | None) -> None:
    """Idempotently add a household_members row and, if phone known, a
    whatsapp_member_mapping row. Safe to call per message."""
    if not display_name:
        return
    existing = sb_get("household_members", {
        "household_id": f"eq.{household_id}",
        "display_name": f"eq.{display_name}",
        "select": "id", "limit": "1",
    })
    if not existing:
        sb_post("household_members", {
            "household_id": household_id,
            "display_name": display_name,
        })
    if phone:
        map_row = sb_get("whatsapp_member_mapping", {
            "household_id": f"eq.{household_id}",
            "phone_number": f"eq.{phone}",
            "select": "phone_number", "limit": "1",
        })
        if not map_row:
            sb_post("whatsapp_member_mapping", {
                "household_id": household_id,
                "phone_number": phone,
                "member_name": display_name,
            })


def insert_group_message(household_id: str, group_id: str, sender_phone: str | None,
                         sender_name: str, text: str, ts_iso: str,
                         classification: str, classification_data: dict | None) -> bool:
    """Insert a group message. dedup key = (group_id, sender_name or phone, ts_iso, text).
    Returns True if inserted, False if already existed.
    """
    dedup_key = sender_phone or f"name:{sender_name}"
    msg_id = make_import_msg_id(f"{group_id}|{dedup_key}", ts_iso, text)
    if message_already_imported(msg_id):
        return False
    sb_post("whatsapp_messages", {
        "household_id": household_id,
        "group_id": group_id,
        "sender_phone": sender_phone,  # may be None for unmapped group members
        "sender_name": sender_name,
        "message_text": text,
        "message_type": "text",
        "whatsapp_message_id": msg_id,
        "classification": classification,
        "classification_data": classification_data,
        "created_at": ts_iso,
    })
    return True


# ─── Per-message resolution tracking ────────────────────────────────────────

NOISE_PATTERN = re.compile(
    r"^[\s\W\d]*$|^(ok|okay|yes|no|thanks|תודה|כן|לא|סבבה|יאללה|אוקי|שבת שלום|בוקר טוב|לילה טוב)\.?$",
    re.IGNORECASE,
)


def is_low_intent(text: str, classification: dict | None) -> bool:
    """Low-intent: ignore-classified OR emoji/reaction-only OR pure noise."""
    t = (text or "").strip()
    if not t:
        return True
    if NOISE_PATTERN.match(t):
        return True
    if classification:
        intent = classification.get("intent")
        conf = float(classification.get("confidence") or 0)
        if intent == "ignore" and conf >= 0.6:
            return True
    return False


_RESOLUTION_SYSTEM_PROMPT = """You are an impartial judge. You decide whether a WhatsApp bot or manual reply addresses a SPECIFIC user's ask.

Output exactly one token: "yes" or "no". No prose, no punctuation, no quotes.
"yes" = the reply resolves THIS user's ask (even partially — a confirmation counts, a rejection counts, a clarifying question counts).
"no"  = the reply is generic, addresses a different user's ask, or ignores this user entirely.
"""


def reply_resolves_ask(user_text: str, reply_text: str,
                       use_llm: bool = True) -> bool:
    """Return True if the reply addresses this user's ask."""
    ut = (user_text or "").strip()
    rt = (reply_text or "").strip()
    if not ut or not rt:
        return False
    # Cheap heuristic first: resolved-markers that are generic.
    if any(mark in rt for mark in RESOLVED_MARKERS):
        # Generic markers without any word/number overlap with the user msg
        # probably addressed a DIFFERENT user — fall through to LLM.
        overlap = any(w for w in ut.split() if len(w) >= 3 and w in rt)
        if overlap:
            return True
    if not use_llm:
        return False
    try:
        user_prompt = (
            f"USER ASK:\n{ut[:400]}\n\nREPLY:\n{rt[:400]}\n\n"
            f"Does the reply address THIS user's ask?"
        )
        out = sonnet_generate(_RESOLUTION_SYSTEM_PROMPT, user_prompt, max_tokens=8)
        return out.strip().lower().startswith("yes")
    except Exception as e:
        print(f"  [resolve] sonnet judge error: {e}; defaulting to needs_recovery",
              file=sys.stderr)
        return False


def resolve_group_messages(parsed: list[dict], dry_run: bool = False) -> None:
    """Annotate each parsed message with a `recovery_state` for group threads.
    Mutates parsed[i] in place. 30-min window for the next non-user reply.
    """
    n = len(parsed)
    for i in range(n):
        msg = parsed[i]
        if is_bot(msg["sender"]):
            continue
        cls = msg.get("classification")
        if is_low_intent(msg["text"], cls):
            msg["recovery_state"] = "low_intent"
            continue
        # Find the next non-user (bot/manual) reply, anywhere ahead in the thread.
        next_reply: dict | None = None
        for j in range(i + 1, n):
            if is_bot(parsed[j]["sender"]):
                delta = (parsed[j]["ts"] - msg["ts"]).total_seconds()
                if delta <= 30 * 60:
                    next_reply = parsed[j]
                break
        if not next_reply:
            msg["recovery_state"] = "needs_recovery"
            continue
        resolved = reply_resolves_ask(msg["text"], next_reply["text"],
                                      use_llm=not dry_run)
        msg["recovery_state"] = "handled" if resolved else "needs_recovery"


# ─── Group file driver ─────────────────────────────────────────────────────

def process_group_file(path: Path, entry: dict, dry_run: bool = False) -> dict:
    fname = path.name
    parsed = parse_export(path)
    if not parsed:
        print(f"  SKIP: {fname} parsed 0 messages (group)", file=sys.stderr)
        return {"file": fname, "status": "skipped_empty_group"}

    # Classify every inbound user message (before resolution tracking, since
    # is_low_intent checks the classification).
    for m in parsed:
        if is_bot(m["sender"]):
            continue
        m["classification"] = haiku_classify(m["text"], m["sender"]) if not dry_run else None

    resolve_group_messages(parsed, dry_run=dry_run)

    user_msgs = [m for m in parsed if not is_bot(m["sender"])]
    bot_msgs = [m for m in parsed if is_bot(m["sender"])]
    unresolved = [m for m in user_msgs if m.get("recovery_state") == "needs_recovery"]

    # Count distinct unresolved users (by name — phones may be missing).
    unresolved_names = sorted({m["sender"] for m in unresolved if m["sender"]})

    if dry_run:
        print(f"  DRY {fname} (group): total={len(parsed)} user={len(user_msgs)} "
              f"bot={len(bot_msgs)} unresolved_users={len(unresolved_names)} "
              f"names={unresolved_names[:5]}")
        return {
            "file": fname, "status": "dry_group",
            "total_messages": len(parsed),
            "unresolved_user_count": len(unresolved_names),
            "unresolved_user_names": unresolved_names,
        }

    hh_id, group_id, created = find_or_create_group_household(entry)

    inserted_in = 0
    inserted_out = 0
    actions_created: dict[str, int] = {}

    for msg in parsed:
        ts_iso = msg["raw_ts_iso"]
        text = msg["text"]
        sender = msg["sender"]
        if is_bot(sender):
            ok = insert_group_message(hh_id, group_id, BOT_PHONE, "שלי", text,
                                      ts_iso, "manual_reply_imported", None)
            if ok:
                inserted_out += 1
            continue
        # User message
        phone = match_member_phone(hh_id, sender)
        ensure_group_member(hh_id, sender, phone)
        cls = msg.get("classification") or {"intent": "ignore", "confidence": 0.0, "entities": {}}
        state = msg.get("recovery_state") or "needs_recovery"
        cls_with_state = {**cls, "recovery_state": state}
        ok = insert_group_message(hh_id, group_id, phone, sender, text, ts_iso,
                                  "backlog_imported_user", cls_with_state)
        if ok:
            inserted_in += 1
            # Materialise CMS actions only for HIGH-confidence actionable intents
            # and only if the message is still "needs_recovery" (meaning the bot
            # likely didn't already handle it live). Keeps the group tidy.
            if state == "needs_recovery":
                touched = materialize_actions(hh_id, cls, text, ts_iso, sender)
                for t in touched:
                    actions_created[t] = actions_created.get(t, 0) + 1

    print(f"  {fname} (group): hh={hh_id}{' [new]' if created else ''} "
          f"gid={group_id} in={inserted_in} out={inserted_out} "
          f"unresolved_users={len(unresolved_names)} actions={actions_created or '-'}")

    return {
        "file": fname,
        "status": "ok_group",
        "household_id": hh_id,
        "group_id": group_id,
        "created_household": created,
        "inserted_inbound": inserted_in,
        "inserted_outbound": inserted_out,
        "unresolved_user_count": len(unresolved_names),
        "unresolved_user_names": unresolved_names,
        "actions": actions_created,
    }


# ─── File-level driver ─────────────────────────────────────────────────────

def process_file(path: Path, manifest_entry: dict | None = None,
                 dry_run: bool = False) -> dict:
    fname = path.name

    # Manifest routing
    if manifest_entry:
        ftype = (manifest_entry.get("type") or "direct").lower()
        if ftype == "group":
            return process_group_file(path, manifest_entry, dry_run=dry_run)
        if ftype != "direct":
            print(f"  SKIP: {fname}: manifest type={ftype!r} not supported", file=sys.stderr)
            return {"file": fname, "status": "skipped_bad_type"}
        phone = (manifest_entry.get("phone") or "").strip() or None
        display_name = (manifest_entry.get("display_name") or "").strip() or None
    else:
        phone = None
        display_name = None

    # Fallback: filename inference (backward compat for 1:1 files without manifest).
    if not phone:
        m = FILENAME_RE.match(fname)
        if not m:
            print(f"  SKIP: filename {fname!r} does not match {{phone}}_{{name}}.txt "
                  f"and no manifest entry", file=sys.stderr)
            return {"file": fname, "status": "skipped_bad_filename"}
        phone = m["phone"]
        if not display_name:
            display_name = (m["name"] or "").replace("-", " ").strip() or "User"
    if not display_name:
        display_name = "User"

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
        dir_path = Path(args.file).parent
    else:
        dir_path = Path(args.dir)
        if not dir_path.exists():
            print(f"No {args.dir}/ — nothing to import. Drop .txt exports there first.")
            return 0
        paths = sorted(dir_path.glob("*.txt"))

    if not paths:
        print(f"No .txt files found under {dir_path}/.")
        return 0

    manifest = load_manifest(dir_path)
    if manifest:
        print(f"Manifest: {len(manifest)} entries loaded from {dir_path}/manifest.json")

    print(f"Processing {len(paths)} export file(s)...")
    summary: list[dict] = []
    for p_path in paths:
        entry = manifest.get(p_path.name)
        # If a manifest exists but this file isn't listed → skip (groups can't
        # be inferred from filename; 1:1 fallback is still fine, so we only
        # warn instead of skipping for direct files).
        if manifest and entry is None:
            print(f"  WARN: {p_path.name} not in manifest — trying filename inference",
                  file=sys.stderr)
        try:
            summary.append(process_file(p_path, manifest_entry=entry, dry_run=args.dry_run))
        except Exception as e:
            print(f"  ERROR on {p_path.name}: {e}", file=sys.stderr)
            summary.append({"file": p_path.name, "status": "error", "error": str(e)})

    total_in = sum(s.get("inserted_inbound", 0) for s in summary)
    total_out = sum(s.get("inserted_outbound", 0) for s in summary)
    households_new = sum(1 for s in summary if s.get("created_household"))
    needs_recovery_1on1 = sum(1 for s in summary if s.get("recovery_state") == "needs_recovery")
    group_unresolved = sum(s.get("unresolved_user_count", 0) or 0
                           for s in summary if s.get("status", "").endswith("group"))
    print("")
    print(f"Done. files={len(summary)} new_households={households_new} "
          f"inbound={total_in} outbound={total_out} "
          f"needs_recovery_1on1={needs_recovery_1on1} "
          f"group_unresolved_users={group_unresolved}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
