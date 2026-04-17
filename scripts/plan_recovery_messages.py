#!/usr/bin/env python3
"""Plan personalised "recovery" messages for users stranded during the
2026-04-17 ban window. Reads backlog rows imported by the two importers,
asks Sonnet for a per-user apology+offer, stages rows in outbound_queue
(message_type='recovery') for the existing pg_cron drain to send at
6/hour cadence.

Usage:
  python scripts/plan_recovery_messages.py
  python scripts/plan_recovery_messages.py --limit 50
  python scripts/plan_recovery_messages.py --start-hour 9  (ban-lift local hour)
  python scripts/plan_recovery_messages.py --dry-run

The drainer does the actual sending. We just:
  1. Find distinct sender_phone with classification='backlog_imported_user'
     during ban window AND no existing recovery row in outbound_queue.
  2. Skip: recovery_state='handled_manually', noise_only, or already-queued.
  3. Load thread + detected intent → Sonnet with on-brand rules → 1 message.
  4. Stagger scheduled_for values. Cap cadence is enforced by the drainer,
     but spreading scheduled_for times across 4h keeps the queue tidy and
     lets us fail-fast if Whapi breaks partway through.
"""
from __future__ import annotations

import argparse
import random
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    BOT_PHONE, sb_get, sb_post, sonnet_generate,
)

# Ban window (UTC). Inbound messages in this range are recovery candidates.
BAN_START_UTC = datetime(2026, 4, 17, 5, 42, tzinfo=timezone.utc)
BAN_END_UTC = datetime(2026, 4, 18, 5, 42, tzinfo=timezone.utc)

# ─── Sonnet prompt (mirrors SHARED_* rules from index.inlined.ts) ───────────

RECOVERY_SYSTEM_PROMPT = """You are Sheli — a warm, organised, feminine Hebrew family assistant on WhatsApp. Your phone was restricted by WhatsApp for 24 hours because too many new users messaged you at once. You are now writing a SINGLE Hebrew message to ONE user whose message was stuck during that ban.

GROUNDING — MANDATORY:
NEVER reference events, habits, or details that aren't in the provided conversation. Use ONLY what the user actually said.

APOLOGY STYLE — MANDATORY:
- NEVER "סליחה, אני מצטערת" or corporate-robotic tone.
- Light, human acknowledgement: "סורי על האיחור 🙈", "הייתי לא זמינה אתמול", "פספסתי אותך אתמול — חוזרת לחיים 💚".
- Acknowledge → move on. No groveling. No long explanations.

EMOJI ENERGY:
1–2 emoji max. Warm, not chaotic. 💚 🙈 😊 are fine. Avoid 🔥 ✨ 🎉.

HEBREW GRAMMAR:
- Match the user's gender from their verb forms (אני צריך = male, אני צריכה = female). Plural "אתם/אתן" if unknown — default אתם.
- Construct state: "רשימת הקניות" not "הרשימת הקניות".

FORMAT — MANDATORY:
- ≤4 short lines.
- No lists, no bullets, no bold.
- Feminine first-person ("רשמתי", "שמרתי", "איחרתי").
- ONE specific reference to what they asked — never generic "אני כאן בשבילך".
- End with a clear ask: "עוד רלוונטי?" or "רוצה שאוסיף/אזכיר עכשיו?" or "להוסיף?"

DO NOT:
- Mention WhatsApp bans, spam classifiers, restrictions — that's not their problem.
- Promise things you can't verify (like "already done" if it isn't).
- Use templates — each message must feel written for THIS person.

Output: ONLY the Hebrew message text. No preface, no meta-commentary.
"""


def build_sonnet_user_prompt(display_name: str, thread: list[dict],
                             detected_intents: list[str]) -> str:
    lines = []
    lines.append(f"USER: {display_name or 'unknown'}")
    lines.append(f"DETECTED INTENTS FROM THEIR MESSAGES: {', '.join(detected_intents) or 'none (social only)'}")
    lines.append("")
    lines.append("THEIR THREAD (chronological, user first, bot last if any):")
    for m in thread:
        who = "USER" if m["sender_phone"] != BOT_PHONE else "BOT"
        lines.append(f"  [{who}] {m['message_text'][:200]}")
    lines.append("")
    lines.append("Write the recovery message now (Hebrew, ≤4 lines, on-brand).")
    return "\n".join(lines)


# ─── Candidate selection ────────────────────────────────────────────────────

def load_candidates() -> list[dict]:
    """Return list of {phone, display_name, recovery_state, latest_ts}.
    Pulls distinct sender_phone values that have a backlog_imported_user row
    in the ban window.
    """
    rows = sb_get("whatsapp_messages", {
        "classification": "eq.backlog_imported_user",
        "created_at": f"gte.{BAN_START_UTC.isoformat()}",
        "select": "sender_phone,created_at,sender_name",
        "order": "created_at.desc",
        "limit": "5000",
    })
    per_phone: dict[str, dict] = {}
    for r in rows:
        ph = r["sender_phone"]
        if ph not in per_phone:
            per_phone[ph] = {
                "phone": ph,
                "display_name": r.get("sender_name") or "",
                "latest_ts": r["created_at"],
            }
    # Enrich with recovery_state from onboarding_conversations.context.
    out: list[dict] = []
    for ph, d in per_phone.items():
        convos = sb_get("onboarding_conversations", {
            "phone": f"eq.{ph}",
            "select": "context,household_id",
            "limit": "1",
        })
        ctx = (convos[0]["context"] if convos else {}) or {}
        d["recovery_state"] = ctx.get("recovery_state")
        d["household_id"] = (convos[0]["household_id"] if convos else None)
        out.append(d)
    return out


def already_queued(phone: str) -> bool:
    rows = sb_get("outbound_queue", {
        "phone_number": f"eq.{phone}",
        "message_type": "eq.recovery",
        "select": "phone_number",
        "limit": "1",
    })
    return len(rows) > 0


def load_thread(phone: str) -> list[dict]:
    rows = sb_get("whatsapp_messages", {
        "or": f"(sender_phone.eq.{phone},and(sender_phone.eq.{BOT_PHONE},group_id.eq.{phone}@s.whatsapp.net))",
        "select": "sender_phone,sender_name,message_text,classification,classification_data,created_at",
        "order": "created_at.asc",
        "limit": "100",
    })
    return rows


def detected_intents_from_thread(thread: list[dict]) -> list[str]:
    intents: list[str] = []
    for m in thread:
        if m["sender_phone"] == BOT_PHONE:
            continue
        cd = m.get("classification_data") or {}
        i = cd.get("intent")
        if i and i != "ignore" and i not in intents:
            intents.append(i)
    return intents


def is_noise_only(thread: list[dict]) -> bool:
    user_msgs = [m for m in thread if m["sender_phone"] != BOT_PHONE]
    if not user_msgs:
        return True
    intents = detected_intents_from_thread(thread)
    return len(intents) == 0


# ─── Scheduling ─────────────────────────────────────────────────────────────

def stagger_schedule(n: int, start_at: datetime, spread_hours: int = 4) -> list[datetime]:
    """Spread n items across `spread_hours` starting at start_at.
    Drainer still rate-limits to 6/hr; this just orders them tidily.
    """
    if n <= 0:
        return []
    total_sec = max(spread_hours * 3600, 60)
    step = total_sec / max(n, 1)
    out: list[datetime] = []
    for i in range(n):
        jitter = random.randint(-30, 30)
        out.append(start_at + timedelta(seconds=int(i * step) + jitter))
    return out


# ─── Main ───────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=0,
                   help="max users to plan for (0 = no limit)")
    p.add_argument("--start-hour", type=int, default=9,
                   help="local hour to start sends (default 9 = 1h after 08:40 ban lift)")
    p.add_argument("--spread-hours", type=int, default=4,
                   help="spread schedule over N hours (default 4)")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    candidates = load_candidates()
    if args.limit:
        candidates = candidates[:args.limit]
    print(f"Loaded {len(candidates)} candidate user(s) from backlog imports.")

    # Start time: today at start_hour Israel (UTC+3).
    il_now = datetime.now(timezone(timedelta(hours=3)))
    start_local = il_now.replace(hour=args.start_hour, minute=0, second=0, microsecond=0)
    if start_local < il_now:
        # Start hour already passed → start in 5min.
        start_local = il_now + timedelta(minutes=5)
    start_utc = start_local.astimezone(timezone.utc)

    # First pass: filter + plan.
    planned: list[dict] = []
    for c in candidates:
        ph = c["phone"]
        if c.get("recovery_state") == "handled_manually":
            continue
        if already_queued(ph):
            continue
        thread = load_thread(ph)
        if is_noise_only(thread):
            continue
        intents = detected_intents_from_thread(thread)
        planned.append({
            "phone": ph,
            "display_name": c.get("display_name") or "",
            "thread": thread,
            "intents": intents,
            "household_id": c.get("household_id"),
        })

    print(f"After filtering: {len(planned)} to plan (handled_manually/noise/already-queued skipped).")

    times = stagger_schedule(len(planned), start_utc, spread_hours=args.spread_hours)

    ok = 0
    skipped = 0
    for i, plan in enumerate(planned):
        ph = plan["phone"]
        name = plan["display_name"]
        intents = plan["intents"]
        thread = plan["thread"]
        try:
            user_prompt = build_sonnet_user_prompt(name, thread, intents)
            body = sonnet_generate(RECOVERY_SYSTEM_PROMPT, user_prompt, max_tokens=300) if not args.dry_run else "[dry-run — skipping Sonnet call]"
        except Exception as e:
            print(f"  skip {ph}: sonnet failed: {e}", file=sys.stderr)
            skipped += 1
            continue
        body = (body or "").strip()
        if not body:
            print(f"  skip {ph}: empty body")
            skipped += 1
            continue

        scheduled_for = times[i].isoformat()
        meta = {
            "detected_intents": intents,
            "household_id": plan["household_id"],
            "source_message_count": len(thread),
        }
        if args.dry_run:
            print(f"  DRY {ph} ({name}) -> {scheduled_for}")
            print(f"       intents={intents}")
            print(f"       body preview: {body[:80]}")
            ok += 1
            continue
        try:
            sb_post("outbound_queue", {
                "phone_number": ph,
                "display_name": name or None,
                "scheduled_for": scheduled_for,
                "message_type": "recovery",
                "template_variant": None,
                "body": body,
                "metadata": meta,
            }, upsert=True)
            ok += 1
            print(f"  queued {ph} ({name}) @ {scheduled_for}")
        except Exception as e:
            print(f"  FAIL {ph}: {e}", file=sys.stderr)
            skipped += 1

    print("")
    print(f"Done. planned={len(planned)} queued={ok} skipped={skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
