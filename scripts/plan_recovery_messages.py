#!/usr/bin/env python3
"""Plan personalised "recovery" messages for users + groups stranded during
the 2026-04-17 ban window. Reads backlog rows imported by the two importers,
asks Sonnet for a per-user (1:1) or per-group (group) apology+offer, stages
rows in outbound_queue for the existing pg_cron drain to send at 6/hour
cadence (global cap across welcomes, 1:1 recoveries, group recoveries).

Usage:
  python scripts/plan_recovery_messages.py
  python scripts/plan_recovery_messages.py --limit 50
  python scripts/plan_recovery_messages.py --start-hour 9  (ban-lift local hour)
  python scripts/plan_recovery_messages.py --dry-run
  python scripts/plan_recovery_messages.py --groups-only
  python scripts/plan_recovery_messages.py --direct-only

Scheduling priority:
  - Groups first (ban_lift + 1h, spread across 1.5h) — one unified message per
    group unblocks many users; better leverage per outbound slot.
  - 1:1 recoveries after (ban_lift + 2.5h, spread across 2.5h).
  - New live welcomes flow real-time, sharing the same 6/hr global cap.

The drainer does the actual sending. We just:
  1. Find distinct 1:1 sender_phone with classification='backlog_imported_user'.
  2. Find group households with ≥1 message flagged recovery_state='needs_recovery'.
  3. Skip anything already queued (idempotent re-runs).
  4. Call Sonnet per-user (1:1) or per-group with on-brand rules.
  5. Stagger scheduled_for values. Rate cap is enforced by the drainer.
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
BAN_START_UTC = datetime(2026, 4, 16, 0, 0, tzinfo=timezone.utc)
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


# ─── Group recovery ────────────────────────────────────────────────────────

GROUP_RECOVERY_SYSTEM_PROMPT = """You are Sheli — a warm, organised, feminine Hebrew family assistant on WhatsApp. You are writing ONE message to a WHOLE family group whose messages went unanswered yesterday because your phone was restricted by WhatsApp. You are now back.

GROUNDING — MANDATORY:
Use ONLY the actual user asks provided below. Never invent events, people, or details.

APOLOGY STYLE — MANDATORY:
- NO corporate tone. NO "אני מתנצלת על אי הנוחות".
- One warm, human opener acknowledging you were away. Examples:
  "חזרתי 🙈 סורי על האיחור אתמול!"
  "היי כולם, הייתי לא זמינה אתמול — כבר חזרתי 💚"
- One line total for the apology. Then move on to the people.

FORMAT — MANDATORY:
- ONE Hebrew message, ≤8 short lines total.
- No bullets, no bold, no lists.
- Feminine first-person ("רשמתי", "ראיתי", "חוזרת").
- Address each unresolved user BY NAME with ONE line referencing their specific ask. Example: "@דנה — שמעתי על תור לרופא השיניים, רוצה שאזכיר לך?"
- Close with ONE short invitation: "מישהו עוד צריך משהו?" or "לכתוב לי עכשיו אם יש עוד משהו 💚".

EMOJI ENERGY:
1–3 emoji total across the whole message. 💚 🙈 😊 ✨ are fine. Avoid spam.

HEBREW GRAMMAR:
- Plural "אתם/אתן" when addressing the group; feminine singular when addressing one member.
- Construct state: "רשימת הקניות" not "הרשימת הקניות".

DO NOT:
- Mention WhatsApp bans, spam classifiers, or technical reasons.
- Use templates — each group message must feel written for THIS family.
- Promise you've already done things that weren't actually done.

Output: ONLY the Hebrew message text. No preface, no meta-commentary.
"""


def load_group_candidates() -> list[dict]:
    """Return [{household_id, group_id, unresolved: [{sender_name, text, intent}]}].

    Queries whatsapp_messages for rows with
    classification_data->>'recovery_state' = 'needs_recovery' in the ban window.
    """
    rows = sb_get("whatsapp_messages", {
        "classification": "eq.backlog_imported_user",
        "classification_data->>recovery_state": "eq.needs_recovery",
        "created_at": f"gte.{BAN_START_UTC.isoformat()}",
        "group_id": "like.%@g.us",  # real JIDs; synthetic rows caught below
        "select": "household_id,group_id,sender_phone,sender_name,message_text,classification_data,created_at",
        "order": "created_at.asc",
        "limit": "5000",
    })
    # Also pull synthetic-group rows (manifest entries with no real JID yet).
    rows += sb_get("whatsapp_messages", {
        "classification": "eq.backlog_imported_user",
        "classification_data->>recovery_state": "eq.needs_recovery",
        "created_at": f"gte.{BAN_START_UTC.isoformat()}",
        "group_id": "like.group_synthetic_%",
        "select": "household_id,group_id,sender_phone,sender_name,message_text,classification_data,created_at",
        "order": "created_at.asc",
        "limit": "5000",
    })

    per_household: dict[str, dict] = {}
    for r in rows:
        hh_id = r.get("household_id")
        if not hh_id:
            continue
        entry = per_household.setdefault(hh_id, {
            "household_id": hh_id,
            "group_id": r.get("group_id"),
            "unresolved": [],
        })
        entry["unresolved"].append({
            "sender_name": r.get("sender_name") or "חבר",
            "text": r.get("message_text") or "",
            "intent": ((r.get("classification_data") or {}).get("intent")),
        })
    return list(per_household.values())


def already_queued_group(household_id: str) -> bool:
    rows = sb_get("outbound_queue", {
        "household_id": f"eq.{household_id}",
        "message_type": "eq.recovery_group",
        "select": "id",
        "limit": "1",
    })
    return len(rows) > 0


def build_group_sonnet_prompt(resolved_names: list[str],
                              unresolved: list[dict]) -> str:
    """Build the USER-role prompt for the group Sonnet call.
    `unresolved` is a list of {sender_name, text, intent} dicts.
    """
    lines: list[str] = []
    if resolved_names:
        lines.append(f"ALREADY-RESOLVED members (context, do NOT address them by name): {', '.join(resolved_names)}")
        lines.append("")
    lines.append("UNRESOLVED asks — address EACH of these members by name:")
    for u in unresolved:
        intent = (u.get("intent") or "?").replace("_", " ")
        lines.append(f"  - {u['sender_name']} ({intent}): {u['text'][:200]}")
    lines.append("")
    lines.append("Write ONE Hebrew group message now (≤8 lines, on-brand).")
    return "\n".join(lines)


def generate_group_recovery(candidate: dict, dry_run: bool = False) -> dict | None:
    """Produce a single outbound_queue row spec for a group candidate.
    Returns None if the candidate should be skipped.
    """
    unresolved = candidate.get("unresolved") or []
    if not unresolved:
        return None

    # Unique unresolved users, keeping their first message as the representative.
    seen: set[str] = set()
    uniq_unresolved: list[dict] = []
    for u in unresolved:
        key = u["sender_name"] or ""
        if key in seen:
            continue
        seen.add(key)
        uniq_unresolved.append(u)

    unresolved_names = [u["sender_name"] for u in uniq_unresolved]

    # Build prompt; degrade gracefully for >5 unresolved users (generic opener).
    resolved_names: list[str] = []
    if len(uniq_unresolved) > 5:
        # Too many — produce a short generic welcome-back, no roll-call.
        body_text = (
            "חזרתי 🙈 סורי על האיחור אתמול!\n"
            "ראיתי כמה הודעות שלא ענו עליהן.\n"
            "אם מישהו עוד צריך משהו — כתבו לי עכשיו ואני על זה 💚"
        )
        user_prompt = None
    else:
        user_prompt = build_group_sonnet_prompt(resolved_names, uniq_unresolved)

    if dry_run:
        return {
            "household_id": candidate["household_id"],
            "group_id": candidate["group_id"],
            "body": body_text if user_prompt is None else f"[dry-run: would call Sonnet with {len(uniq_unresolved)} unresolved]",
            "unresolved_names": unresolved_names,
            "resolved_names": resolved_names,
            "intents": sorted({u.get("intent") or "" for u in uniq_unresolved}),
        }

    if user_prompt is not None:
        body_text = sonnet_generate(GROUP_RECOVERY_SYSTEM_PROMPT, user_prompt,
                                    max_tokens=500).strip()
    if not body_text:
        return None

    return {
        "household_id": candidate["household_id"],
        "group_id": candidate["group_id"],
        "body": body_text,
        "unresolved_names": unresolved_names,
        "resolved_names": resolved_names,
        "intents": sorted({u.get("intent") or "" for u in uniq_unresolved}),
    }


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

def plan_groups(args, start_utc: datetime) -> tuple[int, int]:
    """Plan unified group recovery messages. Returns (queued, skipped)."""
    if args.direct_only:
        return 0, 0
    group_candidates = load_group_candidates()
    if args.limit:
        group_candidates = group_candidates[:args.limit]
    print(f"Loaded {len(group_candidates)} group candidate(s) from backlog imports.")

    fresh: list[dict] = []
    for c in group_candidates:
        if already_queued_group(c["household_id"]):
            continue
        fresh.append(c)
    print(f"After filtering: {len(fresh)} groups to plan (already-queued skipped).")

    # Groups go out first: ban_lift + 1h, spread across ~1.5h.
    group_times = stagger_schedule(len(fresh), start_utc,
                                   spread_hours=max(1, min(args.group_spread_hours, 3)))

    queued = 0
    skipped = 0
    for i, candidate in enumerate(fresh):
        try:
            plan = generate_group_recovery(candidate, dry_run=args.dry_run)
        except Exception as e:
            print(f"  skip group {candidate['household_id']}: sonnet failed: {e}",
                  file=sys.stderr)
            skipped += 1
            continue
        if not plan:
            skipped += 1
            continue
        scheduled_for = group_times[i].isoformat()
        if args.dry_run:
            print(f"  DRY GROUP {candidate['household_id']} (chat={candidate['group_id']})"
                  f" -> {scheduled_for}")
            print(f"       unresolved={plan['unresolved_names']}")
            print(f"       body preview: {plan['body'][:120]}")
            queued += 1
            continue
        meta = {
            "unresolved_user_names": plan["unresolved_names"],
            "resolved_user_names":   plan["resolved_names"],
            "intents":               plan["intents"],
            "household_id":          candidate["household_id"],
            "source":                "group_backlog_recovery",
        }
        try:
            sb_post("outbound_queue", {
                "phone_number":     None,
                "chat_id":          candidate["group_id"],
                "household_id":     candidate["household_id"],
                "display_name":     None,
                "scheduled_for":    scheduled_for,
                "message_type":     "recovery_group",
                "template_variant": None,
                "body":             plan["body"],
                "metadata":         meta,
            })
            queued += 1
            print(f"  queued group {candidate['household_id']} "
                  f"(users={len(plan['unresolved_names'])}) @ {scheduled_for}")
        except Exception as e:
            print(f"  FAIL group {candidate['household_id']}: {e}", file=sys.stderr)
            skipped += 1
    return queued, skipped


def plan_direct(args, start_utc: datetime) -> tuple[int, int]:
    """Plan 1:1 recovery messages. Returns (queued, skipped)."""
    if args.groups_only:
        return 0, 0

    candidates = load_candidates()
    if args.limit:
        candidates = candidates[:args.limit]
    print(f"Loaded {len(candidates)} candidate 1:1 user(s) from backlog imports.")

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
                "phone_number":     ph,
                "display_name":     name or None,
                "household_id":     plan["household_id"],
                "scheduled_for":    scheduled_for,
                "message_type":     "recovery",
                "template_variant": None,
                "body":             body,
                "metadata":         meta,
            })
            ok += 1
            print(f"  queued {ph} ({name}) @ {scheduled_for}")
        except Exception as e:
            print(f"  FAIL {ph}: {e}", file=sys.stderr)
            skipped += 1
    return ok, skipped


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=0,
                   help="max users/groups to plan for per bucket (0 = no limit)")
    p.add_argument("--start-hour", type=int, default=9,
                   help="local hour to start group sends (default 9 = 1h after 08:40 ban lift)")
    p.add_argument("--spread-hours", type=int, default=4,
                   help="spread 1:1 recoveries over N hours (default 4)")
    p.add_argument("--group-spread-hours", type=int, default=2,
                   help="spread group recoveries over N hours (default 2)")
    p.add_argument("--direct-start-offset-hours", type=float, default=1.5,
                   help="hours AFTER group start to begin 1:1 sends (default 1.5)")
    p.add_argument("--groups-only", action="store_true",
                   help="only plan group recoveries, skip 1:1")
    p.add_argument("--direct-only", action="store_true",
                   help="only plan 1:1 recoveries, skip groups")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    il_now = datetime.now(timezone(timedelta(hours=3)))
    start_local = il_now.replace(hour=args.start_hour, minute=0, second=0, microsecond=0)
    if start_local < il_now:
        start_local = il_now + timedelta(minutes=5)
    group_start_utc = start_local.astimezone(timezone.utc)
    direct_start_utc = group_start_utc + timedelta(hours=args.direct_start_offset_hours)

    g_ok, g_skip = plan_groups(args, group_start_utc)
    d_ok, d_skip = plan_direct(args, direct_start_utc)

    print("")
    print(f"Done. groups_queued={g_ok} groups_skipped={g_skip} "
          f"direct_queued={d_ok} direct_skipped={d_skip}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
