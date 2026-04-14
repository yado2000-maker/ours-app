"""
Sheli WhatsApp Bot — Webhook Integration Test Suite

Sends simulated Whapi webhook payloads to the production Edge Function
and verifies classification, DB state, and reply patterns.

Run:  python tests/test_webhook.py
Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required)
      TEST_PHONE (optional, default: 972552482290)

Output: per-test pass/fail, summary, failures list.
"""

import json
import os
import sys
import time
import uuid
import re
from pathlib import Path
from datetime import datetime, timedelta, timezone

# Fix Windows Hebrew encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_orig_print = print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

# Load .env
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

import requests

# ─── Configuration ───

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
WEBHOOK_URL = f"{SUPABASE_URL}/functions/v1/whatsapp-webhook"

TEST_PHONE = os.environ.get("TEST_PHONE", "972552482290")
TEST_DM_ID = f"{TEST_PHONE}@s.whatsapp.net"       # 1:1 chat (Sonnet path)
TEST_GROUP_CHAT_ID = "120363999999999999@g.us"      # Fake group (Haiku classifier path)
TEST_HOUSEHOLD_ID = "hh_test_integration"
TEST_SENDER_NAME = "Test User"
BOT_PHONE = "972555175553"

# Supabase REST headers (service_role bypasses RLS)
SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

# ─── Test Case Definition ───

class TestCase:
    def __init__(self, name, category, message, expected_intent=None,
                 should_be_ignored=False, db_check=None, reply_pattern=None,
                 setup=None, notes=""):
        self.name = name
        self.category = category
        self.message = message
        self.expected_intent = expected_intent
        self.should_be_ignored = should_be_ignored
        self.db_check = db_check  # {"table": "tasks", "column": "title", "value": "...", "should_exist": True}
        self.reply_pattern = reply_pattern  # regex to match in bot reply
        self.setup = setup  # function to run before test
        self.notes = notes
        self.result = None  # "pass" | "fail" | "error"
        self.detail = ""

# ─── Supabase REST Helpers ───

def sb_get(table, params=None):
    """GET from Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.get(url, headers=SB_HEADERS, params=params or {})
    r.raise_for_status()
    return r.json()

def sb_post(table, data):
    """INSERT into Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.post(url, headers=SB_HEADERS, json=data)
    r.raise_for_status()
    return r.json()

def sb_patch(table, data, params):
    """UPDATE in Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.patch(url, headers=SB_HEADERS, json=data, params=params)
    r.raise_for_status()
    return r.json()

def sb_delete(table, params):
    """DELETE from Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    r = requests.delete(url, headers=SB_HEADERS, params=params)
    r.raise_for_status()

def sb_rpc(fn_name, params=None):
    """Call Supabase RPC function."""
    url = f"{SUPABASE_URL}/rest/v1/rpc/{fn_name}"
    r = requests.post(url, headers=SB_HEADERS, json=params or {})
    r.raise_for_status()
    return r.json()

# ─── Test Infrastructure ───

def generate_msg_id(prefix="test"):
    """Generate unique message ID for each test."""
    return f"{prefix}_{int(time.time())}_{uuid.uuid4().hex[:8]}"

def send_webhook(text, msg_id=None, sender_phone=None, group_id=None, msg_type="text"):
    """Send a simulated Whapi webhook payload to the Edge Function.
    Default group_id is the TEST GROUP (Haiku classifier path).
    Pass group_id=TEST_DM_ID explicitly for 1:1 tests."""
    if msg_id is None:
        msg_id = generate_msg_id()
    payload = {
        "messages": [{
            "id": msg_id,
            "from": sender_phone or TEST_PHONE,
            "from_name": TEST_SENDER_NAME,
            "chat_id": group_id or TEST_GROUP_CHAT_ID,
            "type": msg_type,
            "text": {"body": text},
            "timestamp": int(time.time()),
        }]
    }
    try:
        r = requests.post(WEBHOOK_URL, json=payload, timeout=30)
        return r.status_code, r.text
    except Exception as e:
        return 0, str(e)

def poll_for_message(msg_id, timeout=20, poll_interval=2):
    """Poll whatsapp_messages for the CLASSIFIED message (not just the 'received' log).
    The webhook logs twice: first as 'received', then with the actual classification.
    We want the classification row."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = sb_get("whatsapp_messages", {
            "whatsapp_message_id": f"eq.{msg_id}",
            "select": "classification,classification_data,message_text,sender_phone",
            "order": "created_at.desc",
            "limit": "5",
        })
        if rows:
            # Prefer the row with actual classification (not just 'received')
            classified = [r for r in rows if r.get("classification") not in ("received", "received_1on1", "received_1on1_personal")]
            if classified:
                return classified[0]
            # If only 'received' exists, keep waiting for the classification row
            if time.time() + poll_interval < deadline:
                time.sleep(poll_interval)
                continue
            # Timeout — return whatever we have
            return rows[0]
        time.sleep(poll_interval)
    return None

def poll_for_bot_reply(group_id, after_ts, timeout=20, poll_interval=2):
    """Poll for the bot's reply message after a given timestamp."""
    deadline = time.time() + timeout
    after_iso = datetime.fromtimestamp(after_ts, tz=timezone.utc).isoformat()
    while time.time() < deadline:
        rows = sb_get("whatsapp_messages", {
            "group_id": f"eq.{group_id or TEST_GROUP_CHAT_ID}",
            "sender_phone": f"eq.{BOT_PHONE}",
            "created_at": f"gt.{after_iso}",
            "select": "message_text,classification,created_at",
            "order": "created_at.desc",
            "limit": "1",
        })
        if rows:
            return rows[0]
        time.sleep(poll_interval)
    return None

def check_db_item(table, household_id, column, value, should_exist=True):
    """Check if an item exists in a DB table."""
    rows = sb_get(table, {
        "household_id": f"eq.{household_id}",
        column: f"ilike.*{value}*",
        "select": f"id,{column}",
        "limit": "5",
    })
    exists = len(rows) > 0
    if should_exist and not exists:
        return False, f"Expected {table}.{column} containing '{value}' but not found"
    if not should_exist and exists:
        return False, f"Expected {table}.{column} NOT to contain '{value}' but found {len(rows)} rows"
    return True, ""

# ─── Setup / Teardown ───

def setup_test_household():
    """Ensure test household + onboarding conversation exist."""
    print("  Setting up test household...")

    # Upsert household
    try:
        sb_delete("households_v2", {"id": f"eq.{TEST_HOUSEHOLD_ID}"})
    except Exception:
        pass
    sb_post("households_v2", {
        "id": TEST_HOUSEHOLD_ID,
        "name": "Test Family",
        "lang": "he",
    })

    # Upsert onboarding conversation (1:1 chat state)
    try:
        sb_delete("onboarding_conversations", {"phone": f"eq.{TEST_PHONE}"})
    except Exception:
        pass
    sb_post("onboarding_conversations", {
        "phone": TEST_PHONE,
        "state": "chatting",
        "household_id": TEST_HOUSEHOLD_ID,
        "message_count": 10,
        "nudge_count": 0,
        "tried_capabilities": ["shopping", "task", "reminder"],
        "context": json.dumps({"name": TEST_SENDER_NAME, "gender": "male"}),
    })

    # Upsert whatsapp_config for test group (enables Haiku classifier path)
    try:
        sb_delete("whatsapp_config", {"group_id": f"eq.{TEST_GROUP_CHAT_ID}"})
    except Exception:
        pass
    sb_post("whatsapp_config", {
        "group_id": TEST_GROUP_CHAT_ID,
        "household_id": TEST_HOUSEHOLD_ID,
        "bot_active": True,
        "language": "he",
        "group_message_count": 50,
    })

    # Add test member mapping so bot recognizes test phone in group
    try:
        sb_delete("whatsapp_member_mapping", {"phone_number": f"eq.{TEST_PHONE}"})
    except Exception:
        pass
    sb_post("whatsapp_member_mapping", {
        "household_id": TEST_HOUSEHOLD_ID,
        "phone_number": TEST_PHONE,
        "member_name": TEST_SENDER_NAME,
    })

    # Add household member
    try:
        sb_delete("household_members", {
            "household_id": f"eq.{TEST_HOUSEHOLD_ID}",
            "display_name": f"eq.{TEST_SENDER_NAME}",
        })
    except Exception:
        pass
    sb_post("household_members", {
        "household_id": TEST_HOUSEHOLD_ID,
        "display_name": TEST_SENDER_NAME,
        "gender": "male",
    })

    print("  Test household + group ready.")

def cleanup_test_data():
    """Remove all test data created during the run."""
    print("\n  Cleaning up test data...")
    for table in ["tasks", "shopping_items", "events", "reminder_queue"]:
        try:
            sb_delete(table, {"household_id": f"eq.{TEST_HOUSEHOLD_ID}"})
        except Exception:
            pass
    # Clean test messages (both group and DM)
    for gid in [TEST_GROUP_CHAT_ID, TEST_DM_ID]:
        try:
            sb_delete("whatsapp_messages", {"group_id": f"eq.{gid}"})
        except Exception:
            pass
    # Clean supporting tables
    for table, params in [
        ("whatsapp_config", {"group_id": f"eq.{TEST_GROUP_CHAT_ID}"}),
        ("whatsapp_member_mapping", {"phone_number": f"eq.{TEST_PHONE}"}),
        ("household_members", {"household_id": f"eq.{TEST_HOUSEHOLD_ID}"}),
        ("onboarding_conversations", {"phone": f"eq.{TEST_PHONE}"}),
        ("households_v2", {"id": f"eq.{TEST_HOUSEHOLD_ID}"}),
    ]:
        try:
            sb_delete(table, params)
        except Exception:
            pass
    print("  Cleanup done.")

def add_test_item(table, data):
    """Add a test item to the DB for setup."""
    sb_post(table, {"household_id": TEST_HOUSEHOLD_ID, **data})

# ─── Test Cases ───

def build_test_cases():
    """Build all 46 test cases."""
    cases = []

    # ── Category 1: Shopping List Management (10 tests) ──
    cases.append(TestCase(
        "comma_separated_items", "Shopping",
        "חלב, ביצים, לחם",
        expected_intent="add_shopping",
        notes="3 comma-separated items",
    ))
    cases.append(TestCase(
        "four_comma_items", "Shopping",
        "גזר, מלפפון, בצל, שום",
        expected_intent="add_shopping",
        notes="4 items, regression for bug #4",
    ))
    cases.append(TestCase(
        "bringing_not_buying", "Shopping",
        "מביאה חלב מחר",
        expected_intent="ignore",
        notes="'Bringing' not 'buying' — should be ignored (bug #7)",
    ))
    cases.append(TestCase(
        "english_in_hebrew_chat", "Shopping",
        "pasta and cheese",
        expected_intent="add_shopping",
        notes="English shopping items in Hebrew-primary chat",
    ))
    cases.append(TestCase(
        "single_item_imperative", "Shopping",
        "תוסיפי חלב",
        expected_intent="add_shopping",
        notes="Imperative add — single item",
    ))
    cases.append(TestCase(
        "compound_item_oat_milk", "Shopping",
        "חלב שיבולת שועל נטול סוכר",
        expected_intent="add_shopping",
        notes="Complex compound item — must NOT be split",
    ))
    cases.append(TestCase(
        "compound_item_pickled_cucumbers", "Shopping",
        "מלפפונים במלח גודל קטן",
        expected_intent="add_shopping",
        notes="Complex compound item — must NOT be split",
    ))
    cases.append(TestCase(
        "remove_shopping_item", "Shopping",
        "תמחקי חלב",
        notes="Remove item — verify item deleted from DB",
        setup=lambda: add_test_item("shopping_items", {"name": "חלב", "got": False}),
    ))
    cases.append(TestCase(
        "update_shopping_item", "Shopping",
        "תשני חלב לחלב סויה",
        notes="Update item name — verify renamed in DB",
        setup=lambda: add_test_item("shopping_items", {"name": "חלב", "got": False}),
    ))
    cases.append(TestCase(
        "exact_match_over_substring", "Shopping",
        "תמחקי חלב",
        notes="When both חלב and חלב אורז exist, should prefer exact match (bug E)",
        setup=lambda: (
            add_test_item("shopping_items", {"name": "חלב אורז", "got": False}),
            add_test_item("shopping_items", {"name": "חלב", "got": False}),
        ),
    ))

    # ── Category 2: Task Management (8 tests) ──
    cases.append(TestCase(
        "add_task_kitchen", "Tasks",
        "צריך לנקות את המטבח",
        expected_intent="add_task",
    ))
    cases.append(TestCase(
        "add_task_dishwasher", "Tasks",
        "לפרוק מדיח",
        expected_intent="add_task",
    ))
    cases.append(TestCase(
        "complete_task_done", "Tasks",
        "בוצע",
        notes="Implicit completion — low confidence, may escalate",
        setup=lambda: add_test_item("tasks", {"title": "לנקות את המטבח", "done": False}),
    ))
    cases.append(TestCase(
        "complete_task_handled", "Tasks",
        "טיפלתי בזה",
        notes="Implicit completion",
        setup=lambda: add_test_item("tasks", {"title": "לפרוק מדיח", "done": False}),
    ))
    cases.append(TestCase(
        "complete_task_finished", "Tasks",
        "סיימתי",
        notes="Hebrew completion verb",
    ))
    cases.append(TestCase(
        "complete_task_tupol", "Tasks",
        "טופל",
        notes="Hebrew 'handled' (passive)",
    ))
    cases.append(TestCase(
        "complete_task_specific_chore", "Tasks",
        "שטפתי כלים",
        expected_intent="complete_task",
        notes="Specific chore completion",
        setup=lambda: add_test_item("tasks", {"title": "לשטוף כלים", "done": False}),
    ))
    cases.append(TestCase(
        "claim_task", "Tasks",
        "אני אעשה את הכלים",
        expected_intent="claim_task",
        notes="Self-assignment",
    ))

    # ── Category 3: Reminders (11 tests) ──
    cases.append(TestCase(
        "basic_reminder_at_4", "Reminders",
        "תזכירי לי ב-4 לאסוף ילדים",
        expected_intent="add_reminder",
        notes="Basic reminder, should be 16:00 IST",
    ))
    cases.append(TestCase(
        "reminder_tomorrow_10", "Reminders",
        "תזכירי לי מחר ב-10 להביא חלב",
        expected_intent="add_reminder",
    ))
    cases.append(TestCase(
        "third_person_reminder", "Reminders",
        "תזכירי לאמא להביא חלב מחר ב-10",
        expected_intent="add_reminder",
        notes="Third-person — remind Mom, not sender (bug #16)",
    ))
    cases.append(TestCase(
        "before_buffer_reminder", "Reminders",
        "תזכירי לי לפני השעה 16 לעשות קניות",
        expected_intent="add_reminder",
        notes="'before 16' should set time to ~15:00, not 16:00",
    ))
    cases.append(TestCase(
        "relative_time_reminder", "Reminders",
        "בעוד שעה תזכירי לקחת כביסה",
        expected_intent="add_reminder",
        notes="Relative time — now + 1 hour",
    ))
    cases.append(TestCase(
        "bare_reminder_no_time", "Reminders",
        "תזכירי לי",
        notes="No time specified — should ASK, not create reminder",
    ))
    cases.append(TestCase(
        "alt_phrasing_tagidi", "Reminders",
        "תגידי לי בשעה 10 להתקשר לרופא",
        expected_intent="add_reminder",
        notes="Alternate phrasing: tagidi li",
    ))
    cases.append(TestCase(
        "alt_phrasing_tikhtevi", "Reminders",
        "תכתבי לי בשעה 5 לקנות מתנה",
        expected_intent="add_reminder",
        notes="Alternate phrasing: tikhtevi li",
    ))
    cases.append(TestCase(
        "alt_phrasing_tishlekhi", "Reminders",
        "תשלחי לי הודעה ב-10 להזכיר לי לצלצל",
        expected_intent="add_reminder",
        notes="Alternate phrasing: tishlekhi li hoda'a",
    ))
    cases.append(TestCase(
        "noun_form_reminder", "Reminders",
        "תזכורת להתקשר לרופא ב-3",
        expected_intent="add_reminder",
        notes="Noun form, no imperative verb",
    ))
    cases.append(TestCase(
        "bare_tizkoret_no_details", "Reminders",
        "תזכורת",
        notes="Bare noun, no details — should ASK",
    ))

    # ── Category 4: Events (3 tests) ──
    cases.append(TestCase(
        "add_event_dinner", "Events",
        "יש לנו ארוחת ערב מחר ב-19",
        expected_intent="add_event",
    ))
    cases.append(TestCase(
        "update_event_time_only", "Events",
        "תשני את הארוחה ל-20:00",
        notes="Time-only update — should keep date, change time (bug D)",
        setup=lambda: add_test_item("events", {
            "title": "ארוחת ערב",
            "scheduled_for": (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=16, minute=0).isoformat(),
        }),
    ))
    cases.append(TestCase(
        "remove_event", "Events",
        "תמחקי את הארוחה",
        notes="Remove event",
        setup=lambda: add_test_item("events", {
            "title": "ארוחת ערב",
            "scheduled_for": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        }),
    ))

    # ── Category 5: Ignore / Social (5 tests) ──
    cases.append(TestCase(
        "location_question", "Ignore",
        "איפה בנות?",
        expected_intent="ignore",
        notes="Location question — not for bot (bug #8)",
    ))
    cases.append(TestCase(
        "rotation_question", "Ignore",
        "תור מי?",
        expected_intent="question",
        notes="Rotation question — should be QUESTION not add_task (bug #9)",
    ))
    cases.append(TestCase(
        "lol", "Ignore",
        "לול",
        expected_intent="ignore",
    ))
    cases.append(TestCase(
        "ok", "Ignore",
        "סבבה",
        expected_intent="ignore",
    ))
    cases.append(TestCase(
        "greeting", "Ignore",
        "בוקר טוב",
        expected_intent="ignore",
    ))

    # ── Category 6: Bot Addressing / Name Detection (4 tests) ──
    cases.append(TestCase(
        "sheli_add_shopping", "Addressing",
        "שלי תוסיפי חלב",
        expected_intent="add_shopping",
        notes="Addressed to bot by name",
    ))
    cases.append(TestCase(
        "shel_mi_possessive", "Addressing",
        "של מי הנעליים?",
        expected_intent="ignore",
        notes="Possessive 'shel mi', not bot name",
    ))
    cases.append(TestCase(
        "chaim_sheli_possessive", "Addressing",
        "חיים שלי תביאי לי גלידה",
        expected_intent="ignore",
        notes="'chaim sheli' = 'my life' — possessive, NOT addressing bot",
    ))
    cases.append(TestCase(
        "imperative_reminder", "Addressing",
        "תזכירי לי ב-5",
        expected_intent="add_reminder",
        notes="Imperative = addressed to bot implicitly",
    ))

    # ── Category 7: Corrections (2 tests) ──
    cases.append(TestCase(
        "undo_last", "Corrections",
        "לא התכוונתי, תמחקי",
        expected_intent="correct_bot",
        notes="Undo last action",
    ))
    cases.append(TestCase(
        "single_item_correction", "Corrections",
        "טעית, זה פריט אחד",
        expected_intent="correct_bot",
    ))

    # ── Category 8: Edge Cases (4 tests) ──
    cases.append(TestCase(
        "empty_message", "EdgeCases",
        "",
        should_be_ignored=True,
        notes="Empty message — should be skipped entirely",
    ))
    cases.append(TestCase(
        "garbage_input", "EdgeCases",
        "a]]] %%% !@#",
        notes="Garbage — should not crash",
    ))
    cases.append(TestCase(
        "long_message_truncation", "EdgeCases",
        "x" * 600,
        notes="600 chars — should be truncated to 500, no crash",
    ))
    # Dedup test is special — sends same ID twice
    cases.append(TestCase(
        "dedup_replay", "EdgeCases",
        "תוסיפי גבינה",
        notes="Same message ID sent twice — second should be ignored (bug A)",
    ))

    return cases

# ─── Test Runner ───

def run_test(tc):
    """Run a single test case."""
    msg_id = generate_msg_id(tc.name)

    # Run setup if any
    if tc.setup:
        try:
            tc.setup()
        except Exception as e:
            tc.result = "error"
            tc.detail = f"Setup failed: {e}"
            return

    # Special handling for dedup test
    if tc.name == "dedup_replay":
        return run_dedup_test(tc, msg_id)

    # Special handling for empty message
    if tc.name == "empty_message":
        status, body = send_webhook("", msg_id=msg_id)
        if status == 200:
            tc.result = "pass"
            tc.detail = "Empty message handled (200 OK)"
        else:
            tc.result = "fail"
            tc.detail = f"Expected 200, got {status}: {body[:100]}"
        return

    before_ts = time.time()

    # Send webhook
    status, body = send_webhook(tc.message, msg_id=msg_id)
    if status != 200:
        tc.result = "error"
        tc.detail = f"Webhook returned {status}: {body[:200]}"
        return

    # Wait for the message to be logged
    time.sleep(3)

    # Check classification
    logged = poll_for_message(msg_id, timeout=15)
    if not logged:
        tc.result = "fail"
        tc.detail = "Message never logged to whatsapp_messages"
        return

    # Extract intent from classification_data
    cd = logged.get("classification_data")
    actual_intent = None
    if cd:
        if isinstance(cd, str):
            try:
                cd = json.loads(cd)
            except json.JSONDecodeError:
                cd = {}
        actual_intent = cd.get("intent")

    # Check expected intent
    if tc.expected_intent:
        if actual_intent != tc.expected_intent:
            tc.result = "fail"
            tc.detail = f"Expected intent '{tc.expected_intent}', got '{actual_intent}' (classification: {logged.get('classification')})"
            return

    # Check bot reply if pattern specified
    if tc.reply_pattern:
        reply = poll_for_bot_reply(TEST_GROUP_CHAT_ID, before_ts, timeout=15)
        if not reply:
            tc.result = "fail"
            tc.detail = f"No bot reply found (expected pattern: {tc.reply_pattern})"
            return
        if not re.search(tc.reply_pattern, reply.get("message_text", ""), re.IGNORECASE):
            tc.result = "fail"
            tc.detail = f"Reply didn't match pattern '{tc.reply_pattern}': {reply['message_text'][:100]}"
            return

    # Check DB state if specified
    if tc.db_check:
        ok, err = check_db_item(
            tc.db_check["table"],
            TEST_HOUSEHOLD_ID,
            tc.db_check["column"],
            tc.db_check["value"],
            tc.db_check.get("should_exist", True),
        )
        if not ok:
            tc.result = "fail"
            tc.detail = err
            return

    # If we got here, test passed
    tc.result = "pass"
    intent_str = f" -> {actual_intent}" if actual_intent else ""
    tc.detail = f"classification={logged.get('classification')}{intent_str}"

def run_dedup_test(tc, msg_id):
    """Special test: send same message ID twice, verify second webhook run is blocked.
    Note: a single webhook run may log 2 rows (received + classification) — that's normal.
    Dedup means the SECOND webhook call should be blocked entirely."""
    # First send
    send_webhook(tc.message, msg_id=msg_id)
    time.sleep(8)  # Wait for first to fully process + log

    # Count rows after first send
    rows_after_first = sb_get("whatsapp_messages", {
        "whatsapp_message_id": f"eq.{msg_id}",
        "select": "id,classification",
    })
    first_count = len(rows_after_first)

    # Second send (same ID — should be blocked by dedup)
    send_webhook(tc.message, msg_id=msg_id)
    time.sleep(5)

    # Count rows after second send
    rows_after_second = sb_get("whatsapp_messages", {
        "whatsapp_message_id": f"eq.{msg_id}",
        "select": "id,classification",
    })
    second_count = len(rows_after_second)

    if second_count == first_count:
        tc.result = "pass"
        tc.detail = f"Dedup working: {first_count} rows before, {second_count} after replay (no new rows)"
    else:
        tc.result = "fail"
        tc.detail = f"Dedup BROKEN: {first_count} rows before replay, {second_count} after (added {second_count - first_count} new rows)"

# ─── Main ───

def main():
    # Validate config
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables required.")
        print("Set them via:")
        print("  export SUPABASE_URL=https://wzwwtghtnkapdwlgnrxr.supabase.co")
        print("  export SUPABASE_SERVICE_ROLE_KEY=eyJ...")
        sys.exit(1)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"\n{'='*60}")
    print(f"  Sheli Integration Tests")
    print(f"  {now_str}")
    print(f"  Webhook: {WEBHOOK_URL}")
    print(f"  Test phone: {TEST_PHONE}")
    print(f"{'='*60}\n")

    # Build test cases
    cases = build_test_cases()
    print(f"  {len(cases)} test cases loaded\n")

    # Setup
    try:
        setup_test_household()
    except Exception as e:
        print(f"  FATAL: Setup failed: {e}")
        sys.exit(1)

    # Run tests by category
    categories = {}
    for tc in cases:
        categories.setdefault(tc.category, []).append(tc)

    total_pass = 0
    total_fail = 0
    total_error = 0
    failures = []

    for cat_name, cat_cases in categories.items():
        print(f"\n  {cat_name} ({len(cat_cases)} tests)")
        print(f"  {'~' * 40}")
        for tc in cat_cases:
            try:
                run_test(tc)
            except Exception as e:
                tc.result = "error"
                tc.detail = f"Exception: {e}"

            icon = {"pass": "OK", "fail": "FAIL", "error": "ERR"}.get(tc.result, "?")
            print(f"    [{icon}] {tc.name}: {tc.detail[:100]}")

            if tc.result == "pass":
                total_pass += 1
            elif tc.result == "fail":
                total_fail += 1
                failures.append(tc)
            else:
                total_error += 1
                failures.append(tc)

            # Small delay between tests to avoid rate limiting
            time.sleep(1)

    # Summary
    total = len(cases)
    pct = 100 * total_pass / total if total > 0 else 0
    print(f"\n{'='*60}")
    result_parts = [f"{total_pass}/{total} passed"]
    if total_fail:
        result_parts.append(f"{total_fail} failed")
    if total_error:
        result_parts.append(f"{total_error} errors")
    print(f"  Results: {', '.join(result_parts)} ({pct:.0f}%)")

    if failures:
        print(f"\n  Failures:")
        for tc in failures:
            print(f"    FAIL {tc.name}: {tc.detail}")
            if tc.notes:
                print(f"         Note: {tc.notes}")

    print(f"{'='*60}\n")

    # Cleanup
    try:
        cleanup_test_data()
    except Exception as e:
        print(f"  Warning: cleanup failed: {e}")

    # Exit code
    sys.exit(0 if total_fail == 0 and total_error == 0 else 1)

if __name__ == "__main__":
    main()
