"""
Pull recent Sheli bot replies + the user message that triggered each, for
curation into the Hebrew naturalness eval reference set.

Output: tests/fixtures/hebrew_naturalness_candidates.json
        — 100 candidates ordered by recency, ready for Yaron to filter to 30.

Run: python scripts/extract_bot_replies.py

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required)
"""
import os
import sys
import json
import requests
from pathlib import Path
from datetime import datetime, timedelta, timezone

# Encoding fix for Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    from dotenv import load_dotenv
    # override=True so empty shell env vars don't shadow .env values.
    load_dotenv(Path(__file__).parent.parent / ".env", override=True)
except ImportError:
    pass

SB_URL = os.environ["SUPABASE_URL"]
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BOT_PHONE = "972555175553"
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

# Pull bot replies from last 7 days
since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
url = (
    f"{SB_URL}/rest/v1/whatsapp_messages"
    f"?sender_phone=eq.{BOT_PHONE}"
    f"&created_at=gte.{since}"
    f"&ai_responded=eq.true"
    f"&select=id,group_id,household_id,message_text,classification,in_reply_to,created_at"
    f"&order=created_at.desc&limit=200"
)
res = requests.get(url, headers=HEADERS, timeout=30)
res.raise_for_status()
bot_replies = res.json()
print(f"Pulled {len(bot_replies)} bot replies")

# For each reply, fetch the user message it answered (in_reply_to → whatsapp_messages)
candidates = []
for r in bot_replies[:100]:
    user_msg = None
    if r.get("in_reply_to"):
        u = requests.get(
            f"{SB_URL}/rest/v1/whatsapp_messages"
            f"?whatsapp_message_id=eq.{r['in_reply_to']}"
            f"&select=message_text,sender_phone,sender_name",
            headers=HEADERS, timeout=15,
        )
        if u.ok and u.json():
            user_msg = u.json()[0]
    candidates.append({
        "id": r["id"],
        "household_id": r.get("household_id"),
        "group_id": r.get("group_id"),
        "user_message": (user_msg or {}).get("message_text"),
        "user_sender": (user_msg or {}).get("sender_name"),
        "bot_reply": r["message_text"],
        "classification": r.get("classification"),
        "created_at": r["created_at"],
    })

out = Path(__file__).parent.parent / "tests" / "fixtures" / "hebrew_naturalness_candidates.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Wrote {len(candidates)} candidates → {out}")
