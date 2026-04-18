"""Retroactively Haiku-classify pre-ban 1:1 backlog messages.

Context (2026-04-18 WhatsApp ban recovery):
Pre-ban FB-wave messages arrived at the webhook before the anti-spam ban,
got logged as `classification='received_1on1'` but never classified by
Haiku (webhook overload during the same wave that triggered the ban).
`plan_recovery_messages.py` treats messages without `classification_data.intent`
as noise and skips the sender, so these users would miss personalized
recovery unless we backfill Haiku classification here.

Flow:
  1. Select whatsapp_messages where classification='backlog_imported_user'
     AND classification_data IS NULL.
  2. For each, call haiku_classify(text, sender_name).
  3. PATCH classification_data on the row.

Idempotent: re-running on an already-classified row is a no-op because
the SELECT filter requires classification_data IS NULL.

Default rate: 1 call per 3s = 20/min — safe on Anthropic Tier 2 (50/min).
Pass --pause 13 for Tier 1 safe (4.6/min).
"""
from __future__ import annotations

import argparse
import sys
import time

from _common import ANTHROPIC_KEY, haiku_classify, sb_get, sb_patch


def main() -> int:
    if not ANTHROPIC_KEY:
        print("ERROR: ANTHROPIC_API_KEY is empty in .env. Without it every row "
              "falls through haiku_classify's fallback and stores "
              "{intent:'ignore', conf:0} — silently poisoning the recovery "
              "planner. Set the key and re-run.", file=sys.stderr)
        return 2

    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be classified; no API calls, no writes.")
    ap.add_argument("--pause", type=float, default=3.0,
                    help="Seconds between Haiku calls. Default 3.0 (Tier 2). "
                         "Use 13.0 if on Anthropic Tier 1 (5 req/min).")
    ap.add_argument("--limit", type=int, default=5000,
                    help="Max rows to process in one run. Default 5000.")
    args = ap.parse_args()

    rows = sb_get("whatsapp_messages", {
        "classification": "eq.backlog_imported_user",
        "classification_data": "is.null",
        "select": "id,sender_phone,sender_name,message_text,created_at",
        "order": "created_at.asc",
        "limit": str(args.limit),
    })
    print(f"Found {len(rows)} rows needing Haiku classification.")

    if args.dry_run:
        print("\nDRY-RUN: no API calls, no DB writes.")
        print("\nFirst 10 samples:")
        for r in rows[:10]:
            name = (r.get("sender_name") or "")[:20]
            text = (r.get("message_text") or "")[:60]
            print(f"  {r['sender_phone']:>15} | {name:<20} | {text}")
        if len(rows) > 10:
            print(f"  ... ({len(rows) - 10} more)")
        return 0

    updated = 0
    failed = 0
    skipped_empty = 0
    for i, r in enumerate(rows, 1):
        text = (r.get("message_text") or "").strip()
        if not text:
            skipped_empty += 1
            continue
        try:
            cd = haiku_classify(text, r.get("sender_name") or "משתמש")
            sb_patch("whatsapp_messages",
                     {"id": r["id"]},
                     {"classification_data": cd})
            updated += 1
            print(f"  [{i}/{len(rows)}] ✓ {r['sender_phone']:>15} "
                  f"intent={cd['intent']:<18} conf={cd['confidence']:.2f}")
        except Exception as e:
            failed += 1
            print(f"  [{i}/{len(rows)}] ✗ {r['sender_phone']:>15} {e}",
                  file=sys.stderr)
        if i < len(rows):
            time.sleep(args.pause)

    print(f"\nDone. updated={updated} failed={failed} skipped_empty={skipped_empty}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
