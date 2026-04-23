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
                 negative_reply_pattern=None,
                 setup=None, teardown=None,
                 expected_classification=None,
                 expected_living_vs_operating=None,
                 notes="", chat_id=None, forwarded=False):
        self.name = name
        self.category = category
        self.message = message
        self.expected_intent = expected_intent
        self.should_be_ignored = should_be_ignored
        self.db_check = db_check  # {"table": "tasks", "column": "title", "value": "...", "should_exist": True}
        self.reply_pattern = reply_pattern  # regex that bot reply MUST match
        self.negative_reply_pattern = negative_reply_pattern  # regex that bot reply must NOT match
        self.setup = setup  # function to run before test
        self.teardown = teardown  # function to run after test (always — even on failure)
        self.expected_classification = expected_classification  # optional whatsapp_messages.classification match
        self.expected_living_vs_operating = expected_living_vs_operating  # optional classification_data.living_vs_operating match
        self.notes = notes
        # Chat ID for the webhook payload. Default = group (Haiku classifier path).
        # Pass TEST_DM_ID explicitly for 1:1 tests (Sonnet path, no Haiku classification).
        self.chat_id = chat_id or TEST_GROUP_CHAT_ID
        # WhatsApp forwarded flag — exercises the forward-to-task short-circuit
        # in handleDirectMessage (1:1 only per product scope).
        self.forwarded = forwarded
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

def send_webhook(text, msg_id=None, sender_phone=None, group_id=None, msg_type="text", forwarded=False):
    """Send a simulated Whapi webhook payload to the Edge Function.
    Default group_id is the TEST GROUP (Haiku classifier path).
    Pass group_id=TEST_DM_ID explicitly for 1:1 tests.
    Pass forwarded=True to exercise the forward-to-task short-circuit."""
    if msg_id is None:
        msg_id = generate_msg_id()
    msg_body = {
        "id": msg_id,
        "from": sender_phone or TEST_PHONE,
        "from_name": TEST_SENDER_NAME,
        "chat_id": group_id or TEST_GROUP_CHAT_ID,
        "type": msg_type,
        "text": {"body": text},
        "timestamp": int(time.time()),
    }
    if forwarded:
        # Matches Whapi's top-level `forwarded` payload shape. The parser
        # also ORs against msg.context.forwarded and msg.forwarded_score>=1,
        # so any single shape is sufficient for the test.
        msg_body["forwarded"] = True
    payload = {"messages": [msg_body]}
    try:
        r = requests.post(WEBHOOK_URL, json=payload, timeout=30)
        return r.status_code, r.text
    except Exception as e:
        return 0, str(e)

def log_lookup_id(chat_id):
    """Convert a Whapi chat_id to the group_id as stored in whatsapp_messages.
    DMs are stored as the bare phone (no @s.whatsapp.net); groups keep @g.us intact.
    See CLAUDE.md 'group_id format mismatch across tables'."""
    if chat_id.endswith("@s.whatsapp.net"):
        return chat_id.replace("@s.whatsapp.net", "")
    return chat_id

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

def check_db_item_exact(table, household_id, column, value):
    """Check the most recent row in a DB table for an exact column value.
    Used for numeric/enum fields (e.g. amount_minor=130000, currency='EUR')
    where ilike pattern matching doesn't apply."""
    rows = sb_get(table, {
        "household_id": f"eq.{household_id}",
        "deleted": "eq.false",
        "select": f"id,{column}",
        "order": "created_at.desc",
        "limit": "1",
    })
    if not rows:
        return False, f"No rows in {table} for household {household_id}"
    actual = rows[0].get(column)
    if actual == value:
        return True, ""
    return False, f"Expected {table}.{column}={value}, got {actual}"

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
    for table in ["tasks", "shopping_items", "events", "reminder_queue", "expenses"]:
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

def clear_reminder_queue():
    """Drop all reminder_queue rows for the test household.

    Used as per-test `setup` for reminder cases so each test's db_check isn't
    polluted by earlier tests that share TEST_HOUSEHOLD_ID. Without this,
    check_db_item would return True for leftover rows from previous cases that
    happen to share a keyword (e.g. 'רופא' appears in multiple reminder texts).
    """
    try:
        sb_delete("reminder_queue", {"household_id": f"eq.{TEST_HOUSEHOLD_ID}"})
    except Exception:
        pass

def clear_expenses():
    """Drop all expenses rows for the test household.

    Used as per-test `setup` for expense cases so each test's db_check isn't
    polluted by leftover rows from previous expense tests.
    """
    try:
        sb_delete("expenses", {"household_id": f"eq.{TEST_HOUSEHOLD_ID}"})
    except Exception:
        pass

# ─── Test Cases ───

def build_test_cases():
    """Build all 74 test cases (47 original + 26 expenses + 1 bot-reply-logging)."""
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
    # NOTE: db_check on reminder_queue guards against the silent-drop bug — where
    # direct_address_reply paths used to strip Sonnet's REMINDER block without saving
    # it. Each test clears reminder_queue first (setup) so the db_check's ilike match
    # isn't polluted by overlapping keywords from previous reminder tests.
    cases.append(TestCase(
        "basic_reminder_at_4", "Reminders",
        "תזכירי לי ב-4 לאסוף ילדים",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "ילדים"},
        notes="Basic reminder, should be 16:00 IST; verifies reminder_queue row exists",
    ))
    cases.append(TestCase(
        "reminder_tomorrow_10", "Reminders",
        "תזכירי לי מחר ב-10 להביא חלב",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "להביא חלב"},
    ))
    cases.append(TestCase(
        "third_person_reminder", "Reminders",
        "תזכירי לאמא להביא חלב מחר ב-10",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "אמא"},
        notes="Third-person — remind Mom, not sender (bug #16); reminder_text must include 'אמא'",
    ))
    cases.append(TestCase(
        "before_buffer_reminder", "Reminders",
        "תזכירי לי לפני השעה 16 לעשות קניות",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "קניות"},
        notes="'before 16' should set time to ~15:00, not 16:00",
    ))
    cases.append(TestCase(
        "relative_time_reminder", "Reminders",
        "בעוד שעה תזכירי לקחת כביסה",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "כביסה"},
        notes="Relative time — now + 1 hour",
    ))
    cases.append(TestCase(
        "bare_reminder_no_time", "Reminders",
        "תזכירי לי",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "תזכירי", "should_exist": False},
        notes="No time specified — should ASK, not create reminder; reminder_queue must stay empty",
    ))
    cases.append(TestCase(
        "alt_phrasing_tagidi", "Reminders",
        "תגידי לי בשעה 10 להתקשר לרופא",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "רופא"},
        notes="Alternate phrasing: tagidi li",
    ))
    cases.append(TestCase(
        "alt_phrasing_tikhtevi", "Reminders",
        "תכתבי לי בשעה 5 לקנות מתנה",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "מתנה"},
        notes="Alternate phrasing: tikhtevi li",
    ))
    cases.append(TestCase(
        "alt_phrasing_tishlekhi", "Reminders",
        "תשלחי לי הודעה ב-10 להזכיר לי לצלצל",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "לצלצל"},
        notes="Alternate phrasing: tishlekhi li hoda'a",
    ))
    cases.append(TestCase(
        "noun_form_reminder", "Reminders",
        "תזכורת להתקשר לרופא ב-3",
        expected_intent="add_reminder",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "רופא"},
        notes="Noun form, no imperative verb",
    ))
    cases.append(TestCase(
        "bare_tizkoret_no_details", "Reminders",
        "תזכורת",
        setup=clear_reminder_queue,
        db_check={"table": "reminder_queue", "column": "message_text", "value": "תזכורת", "should_exist": False},
        notes="Bare noun, no details — should ASK; reminder_queue must stay empty",
    ))

    # ── Category 4: Events (4 tests) ──
    cases.append(TestCase(
        "add_event_dinner", "Events",
        "יש לנו ארוחת ערב מחר ב-19",
        expected_intent="add_event",
    ))
    # Bug 1 (2026-04-20) regression — "תרשמי ב {date}" must materialise an events
    # row even when Haiku initially classifies as 'ignore' and Sonnet rescues
    # the EVENT block. The DB check is the bug, not the intent.
    cases.append(TestCase(
        "add_event_via_tirshmi_date", "Events",
        "תרשמי ב 12.5 המקהלה של נעמי בהופעה בת״א וירושלים",
        db_check={"table": "events", "column": "title", "value": "המקהלה של נעמי בהופעה בת״א וירושלים", "should_exist": True},
        notes="Bug 1: Sonnet emitted EVENT block, rescue must save it",
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

    # ── Category 5b: Social Noise — Sheli stays out (9 tests, added 2026-04-22) ──
    # Three patterns Sheli must NOT turn into tasks:
    #   (a) INDIRECT PLEAS: "שמישהו [verb]" — asking unnamed family member for a favor
    #   (b) BARE INFINITIVE DELIBERATIONS: "לעשות X?" — "should I/we X?" asked between humans
    #   (c) IN-THE-MOMENT COMMANDS: deictic "את זה" — pointing at a physical thing now
    # All three resolve to ignore unless שלי/@שלי is explicitly tagged.
    cases.append(TestCase(
        "indirect_plea_boiler", "SocialNoise",
        "שמישהו ידליק לי את הדוד",
        expected_intent="ignore",
        notes="Indirect plea — mom/dad asking an unnamed family member. NOT a task for Sheli.",
    ))
    cases.append(TestCase(
        "indirect_plea_laundry", "SocialNoise",
        "מישהו יכול להוריד את הכביסה?",
        expected_intent="ignore",
        notes="Indirect plea with '?' — same pattern.",
    ))
    cases.append(TestCase(
        "indirect_plea_window", "SocialNoise",
        "אולי מישהו יפתח חלון",
        expected_intent="ignore",
        notes="Indirect plea variant ('אולי מישהו').",
    ))
    cases.append(TestCase(
        "deliberation_shoshi", "SocialNoise",
        "לאסוף את שושי?",
        expected_intent="ignore",
        notes="Bare-infinitive deliberation — 'should I pick up Shoshi?' Family decides, not Sheli.",
    ))
    cases.append(TestCase(
        "deliberation_milk", "SocialNoise",
        "להביא חלב מהמכולת?",
        expected_intent="ignore",
        notes="Bare-infinitive deliberation. Same words without '?' could be add_task.",
    ))
    cases.append(TestCase(
        "deliberation_gift", "SocialNoise",
        "לקנות מתנה לסבתא?",
        expected_intent="ignore",
        notes="Bare-infinitive deliberation — deciding together, not delegating to Sheli.",
    ))
    cases.append(TestCase(
        "moment_command_trash", "SocialNoise",
        "לפנות את זה לזבל",
        expected_intent="ignore",
        notes="In-the-moment command with deictic 'את זה' (THIS). Golan family 2026-04-21 incident.",
    ))
    cases.append(TestCase(
        "moment_command_throw", "SocialNoise",
        "תזרקי את זה",
        expected_intent="ignore",
        notes="Imperative with deictic 'את זה' — pointing at a physical thing right now.",
    ))
    cases.append(TestCase(
        "moment_command_tidy", "SocialNoise",
        "תסדרו את זה",
        expected_intent="ignore",
        notes="Imperative with deictic 'את זה'. Plural form (family-directed).",
    ))
    # Positive counter-examples — same verbs WITHOUT the social-noise signals
    # should STILL classify as tasks/shopping. If these start failing, the rule
    # over-generalized and the product loses its core value.
    cases.append(TestCase(
        "counter_buy_gift_no_q", "SocialNoise",
        "לקנות מתנה לסבתא",
        expected_intent="add_task",
        notes="Counter-example — same words as deliberation_gift but NO '?'. Must still be add_task.",
    ))
    cases.append(TestCase(
        "counter_clean_kitchen", "SocialNoise",
        "לנקות את המטבח ביום שישי",
        expected_intent="add_task",
        notes="Counter-example — infinitive cleanup verb BUT with time reference (not in-the-moment).",
    ))

    # ── Category 5c: Scope — Visit-not-residency (Phase 2, added 2026-04-22) ──
    # Sheli stays warm-but-external during living-moment invitations. She cheers,
    # she does not claim family membership. Positive reply must be warm; forbidden
    # phrases indicate identity leak ("אני חלק מהמשפחה", "אני מתרגשת ביחד איתכם", "אנחנו משפחה").
    cases.append(TestCase(
        "visit_not_residency_holds_identity", "Scope",
        "שלי תראי איזה ציור עידו צייר בגן!",
        expected_intent="ignore",
        reply_pattern=r"(כל הכבוד|יופי|חמוד|מדהים|איזה|חמד)",
        negative_reply_pattern=r"(אני חלק מהמשפחה|אני מתרגשת ביחד איתכם|אנחנו משפחה|אנחנו מתרגשים)",
        notes="VISIT_NOT_RESIDENCY — Sheli cheers warmly as an external helper; must not claim kinship.",
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

    # ── Category 7b: Correction Phrases (Phase 3, added 2026-04-22) ──
    # Four one-word "back off" phrases. Pre-classifier match routes to the
    # existing quick-undo handler AND sets whatsapp_config.quiet_until for 10 min.
    # Tested at the reply level (ack like "הבנתי 🤫") — intent field is null on
    # the pre-classifier path, so we rely on reply_pattern instead of expected_intent.
    cases.append(TestCase(
        "correction_shakat", "Correction",
        "שלי שקט",
        reply_pattern=r"(הבנתי|אוקי|שקט|🤫)",
        notes="Phase 3 correction phrase: שלי שקט → undo + 10-min cool-down.",
    ))
    cases.append(TestCase(
        "correction_lo_achshav", "Correction",
        "שלי לא עכשיו",
        reply_pattern=r"(הבנתי|אוקי|שקט|🤫)",
        notes="Phase 3 correction phrase: שלי לא עכשיו.",
    ))
    cases.append(TestCase(
        "correction_tirageyi", "Correction",
        "שלי תירגעי",
        reply_pattern=r"(הבנתי|אוקי|שקט|🤫)",
        notes="Phase 3 correction phrase: שלי תירגעי.",
    ))
    cases.append(TestCase(
        "correction_lo_elayich", "Correction",
        "שלי לא אלייך",
        reply_pattern=r"(הבנתי|אוקי|שקט|🤫)",
        notes="Phase 3 correction phrase: שלי לא אלייך.",
    ))

    # ── Phase 3 Task 3.4: cool-down gate ──
    # quiet_until set to 5 min in the future on setup; ambient messages should
    # be suppressed_cooldown; explicit @שלי addresses should fire anyway.
    def _set_cooldown():
        now_plus_5 = (datetime.utcnow() + timedelta(minutes=5)).isoformat() + "Z"
        sb_patch("whatsapp_config",
                 {"quiet_until": now_plus_5},
                 {"group_id": f"eq.{TEST_GROUP_CHAT_ID}"})

    def _clear_cooldown():
        sb_patch("whatsapp_config",
                 {"quiet_until": None},
                 {"group_id": f"eq.{TEST_GROUP_CHAT_ID}"})

    cases.append(TestCase(
        "ambient_silent_during_cooldown", "Correction",
        "צריך לקנות חלב",  # operating-ambient; would normally fire
        setup=_set_cooldown,
        teardown=_clear_cooldown,
        expected_classification="suppressed_cooldown",
        notes="Phase 3.4: ambient operating message during cool-down must be suppressed.",
    ))
    cases.append(TestCase(
        "explicit_addressing_still_works_during_cooldown", "Correction",
        "שלי תוסיפי חלב לרשימה",  # explicit + operating
        setup=_set_cooldown,
        teardown=_clear_cooldown,
        expected_intent="add_shopping",
        notes="Phase 3.4: explicit @שלי address bypasses cool-down.",
    ))

    # ── Phase 4 Task 4.4: household pattern suppresses misclassification ──
    # Seed a living_layer_trigger in the test household; confirm the classifier
    # now treats the same text as 'ignore' rather than add_task.
    def _seed_living_layer_trigger():
        sb_post("household_patterns", {
            "household_id": TEST_HOUSEHOLD_ID,
            "pattern_type": "living_layer_trigger",
            "pattern_key": "תאסוף את שושי עכשיו",
            "pattern_value": "תאסוף את שושי עכשיו",
            "confidence": 0.8,
            "hit_count": 3,
        })

    def _clear_living_layer_trigger():
        sb_delete("household_patterns", {
            "household_id": f"eq.{TEST_HOUSEHOLD_ID}",
            "pattern_type": "eq.living_layer_trigger",
        })

    cases.append(TestCase(
        "household_pattern_suppresses_misclassification", "Patterns",
        "תאסוף את שושי עכשיו",
        setup=_seed_living_layer_trigger,
        teardown=_clear_living_layer_trigger,
        expected_intent="ignore",
        notes="Phase 4.4: living_layer_trigger injected into FAMILY PATTERNS should suppress misclassification.",
    ))

    # ── Phase 5 Task 5.1: living_vs_operating layer discrimination (10 tests) ──
    # Paired few-shots — same or similar verb, different layer signal.
    # The discriminator is punctuation / time-marker / addressing / deictic.
    # These tests verify Haiku emits the new living_vs_operating field AND
    # classifies each message to the correct layer. Intent is orthogonal —
    # we don't constrain it (depends on ambient context which varies).
    cases.append(TestCase(
        "layer_buy_milk_plain", "LayerDiscrimination",
        "לקנות חלב",
        expected_living_vs_operating="operating",
        notes="Phase 5.1: bare infinitive, no urgency → operating.",
    ))
    cases.append(TestCase(
        "layer_buy_milk_urgent", "LayerDiscrimination",
        "לקנות חלב?!",
        expected_living_vs_operating="living",
        notes="Phase 5.1: same verb but ?! = live moment → living.",
    ))
    cases.append(TestCase(
        "layer_pickup_planning", "LayerDiscrimination",
        "נצטרך לאסוף את שושי בארבע",
        expected_living_vs_operating="operating",
        notes="Phase 5.1: future tense + explicit time → operating.",
    ))
    cases.append(TestCase(
        "layer_pickup_now", "LayerDiscrimination",
        "תאסוף את שושי עכשיו",
        expected_living_vs_operating="living",
        notes="Phase 5.1: imperative + 'עכשיו' now-marker → living.",
    ))
    cases.append(TestCase(
        "layer_dentist_planning", "LayerDiscrimination",
        "צריך תור לרופא שיניים לעידו",
        expected_living_vs_operating="operating",
        notes="Phase 5.1: appointment planning → operating.",
    ))
    cases.append(TestCase(
        "layer_hurry_up", "LayerDiscrimination",
        "תזדרזו כבר!",
        expected_living_vs_operating="living",
        notes="Phase 5.1: urgency-now exclamation → living.",
    ))
    cases.append(TestCase(
        "layer_see_drawing", "LayerDiscrimination",
        "שלי תראי את הציור של עידו",
        expected_living_vs_operating="living",
        notes="Phase 5.1: explicit + celebration invitation → living.",
    ))
    cases.append(TestCase(
        "layer_remind_tomorrow", "LayerDiscrimination",
        "שלי תזכירי לי מחר ב-9",
        expected_living_vs_operating="operating",
        notes="Phase 5.1: explicit + planning (reminder with time) → operating.",
    ))
    cases.append(TestCase(
        "layer_indirect_wine", "LayerDiscrimination",
        "מישהו יביא יין בדרך?",
        expected_living_vs_operating="living",
        notes="Phase 5.1: indirect plea, no specific time → living.",
    ))
    cases.append(TestCase(
        "layer_call_mom_shabbat", "LayerDiscrimination",
        "תקראי לאמא שתבוא לארוחה בשבת",
        expected_living_vs_operating="operating",
        notes="Phase 5.1: planning with time reference → operating.",
    ))

    # ── Phase 5 Task 5.3: matrix cell routing (new silence gates) ──
    # Three tests exercising the NEW gates. Existing operating-cell behavior is
    # already covered by the 100+ earlier tests — no need to duplicate.
    cases.append(TestCase(
        "matrix_ambient_living_silent", "MatrixRouting",
        "תזדרזו כבר!",  # ambient + living (urgency-now exclamation, no @שלי)
        expected_classification="suppressed_ambient_living",
        notes="Phase 5.3: ambient + living must be silenced (no action, no reply).",
    ))
    # NOTE: Option A tightening (2026-04-23): ambient_ambiguous falls through
    # to intent-based routing. Only ambient_living is silenced by the matrix gate.
    # See commit tightening Task 5.3 after full-regression dropped to 81%.
    # ambient_ambiguous is now exercised by the 100+ existing tests (expense_*,
    # counter_*) which ride the intent gate unchanged.
    cases.append(TestCase(
        "matrix_explicit_operating_unchanged", "MatrixRouting",
        "שלי תוסיפי חלב",  # explicit + operating (existing behavior preserved)
        expected_intent="add_shopping",
        notes="Phase 5.3 regression: explicit + operating still fires add_shopping as before.",
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

    # ── Category 9: Expenses ──
    # NOTE: reply_pattern is only used when reply content is the PRIMARY assertion.
    # For classification + DB tests, we check intent + db_check (more reliable than
    # reply detection which depends on Whapi send succeeding for the test group).

    # ── Expense: Core classification + DB write ──
    cases.append(TestCase(
        "expense_speaker_ils", "Expenses",
        "שילמתי 1300 חשמל",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 130000},
        notes="Speaker attribution, ILS default, 1300 ILS = 130000 minor",
    ))
    cases.append(TestCase(
        "expense_named", "Expenses",
        "אבא שילם 500 סופר",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 50000},
        notes="Named attribution — 'dad paid 500'",
    ))
    cases.append(TestCase(
        "expense_joint", "Expenses",
        "שילמנו 2400 ארנונה",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 240000},
        notes="Joint attribution — 'we paid 2400'",
    ))
    cases.append(TestCase(
        "expense_slang", "Expenses",
        "שרפתי 500 על דלק",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 50000},
        notes="Hebrew slang 'שרפתי' (burned) = paid",
    ))

    # ── Expense: Currency detection ──
    cases.append(TestCase(
        "expense_eur", "Expenses",
        "שילמתי 150 יורו דלק",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "currency", "value": "EUR"},
        notes="EUR detection from 'יורו'",
    ))
    cases.append(TestCase(
        "expense_usd_word", "Expenses",
        "שילמתי 80 דולר על ארוחה",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "currency", "value": "USD"},
        notes="USD detection from Hebrew word 'דולר'",
    ))
    cases.append(TestCase(
        "expense_usd_symbol", "Expenses",
        "שילמתי $80 על מתנה",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "currency", "value": "USD"},
        notes="USD detection from '$' symbol prefix — may need prompt example",
    ))
    cases.append(TestCase(
        "expense_gbp", "Expenses",
        "שילמתי 50 פאונד על מתנה",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "currency", "value": "GBP"},
        notes="GBP detection from Hebrew 'פאונד'",
    ))
    cases.append(TestCase(
        "expense_jpy", "Expenses",
        "שילמתי 10000 ין על ארוחה ביפן",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "currency", "value": "JPY"},
        notes="JPY detection — minor_unit=1, 10000 yen = 10000 minor",
    ))
    cases.append(TestCase(
        "expense_ils_explicit", "Expenses",
        "שילמתי 200 שקל על גז",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 20000},
        notes="Explicit ILS from 'שקל' — 200 ILS = 20000 minor",
    ))

    # ── Expense: Verb/attribution variants ──
    cases.append(TestCase(
        "expense_transfer_verb", "Expenses",
        "העברתי 5000 שקל שכירות",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 500000},
        notes="Transfer verb 'העברתי' = speaker paid",
    ))
    cases.append(TestCase(
        "expense_cost_verb", "Expenses",
        "עלה לי 300 השמאי",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 30000},
        notes="Cost verb 'עלה לי' = speaker paid",
    ))
    cases.append(TestCase(
        "expense_passive", "Expenses",
        "שולם 180 ביטוח",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 18000},
        notes="Passive form 'שולם' = household/unattributed",
    ))
    cases.append(TestCase(
        "expense_joint_cost", "Expenses",
        "יצא לנו 600 על הקניות",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 60000},
        notes="Joint slang 'יצא לנו' = we paid together",
    ))
    cases.append(TestCase(
        "expense_fine", "Expenses",
        "חטפתי דוח חניה 250 שקל",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 25000},
        notes="Parking fine with slang verb 'חטפתי'",
    ))
    cases.append(TestCase(
        "expense_bought_with_price", "Expenses",
        "קניתי מזגן ב-3000 שקל",
        expected_intent="add_expense",
        setup=clear_expenses,
        db_check={"table": "expenses", "field": "amount_minor", "value": 300000},
        notes="'Bought X for Y' rule — should be expense, NOT shopping",
    ))

    # ── Expense: No-amount follow-up ──
    cases.append(TestCase(
        "expense_no_amount", "Expenses",
        "שילמתי חשמל",
        setup=clear_expenses,
        notes="No amount → flaky (rescue needs verb+number). When classified: bot asks 'כמה עלה?'",
    ))

    # ── Expense: Negative cases (NOT expenses) ──
    cases.append(TestCase(
        "expense_neg_treating", "Expenses",
        "שילמתי עליו 50 בבית קפה",
        expected_intent="ignore",
        setup=clear_expenses,
        notes="Social treating ('paid for him') — NOT a household expense",
    ))
    cases.append(TestCase(
        "expense_neg_task", "Expenses",
        "צריך לשלם ארנונה",
        expected_intent="add_task",
        setup=clear_expenses,
        notes="Future payment obligation — should be a task, not an expense",
    ))
    cases.append(TestCase(
        "expense_neg_bill_arrived", "Expenses",
        "הגיע חשבון חשמל של 1300",
        expected_intent="ignore",
        setup=clear_expenses,
        notes="Bill arrived but NOT paid — not an expense",
    ))
    cases.append(TestCase(
        "expense_neg_present_tense", "Expenses",
        "המשכנתא עולה 4000 בחודש",
        expected_intent="ignore",
        setup=clear_expenses,
        notes="Present tense cost statement — not a past expense",
    ))
    cases.append(TestCase(
        "expense_neg_grocery_no_price", "Expenses",
        "קניתי חלב",
        should_be_ignored=True,
        setup=clear_expenses,
        notes="'Bought milk' no price → complete_shopping or ignore (not expense). Accept either.",
    ))

    # ── Expense: Queries (must address bot by name in group) ──
    cases.append(TestCase(
        "expense_query_summary", "Expenses",
        "שלי כמה שילמנו החודש?",
        expected_intent="query_expense",
        setup=clear_expenses,
        notes="Monthly summary query — addressed to שלי",
    ))
    cases.append(TestCase(
        "expense_query_last_month", "Expenses",
        "שלי כמה הוצאנו בחודש שעבר?",
        expected_intent="query_expense",
        setup=clear_expenses,
        notes="Last month query — addressed to שלי",
    ))
    cases.append(TestCase(
        "expense_query_category", "Expenses",
        "שלי כמה שילמנו על חשמל החודש?",
        expected_intent="query_expense",
        setup=clear_expenses,
        notes="Category-specific query — electricity this month",
    ))

    # ── Bot Reply Logging (1 test) ──
    cases.append(TestCase(
        "bot_reply_logged", "BotReplyLogging",
        "תוסיפי חלב לרשימה",
        expected_intent="add_shopping",
        db_check={"table": "whatsapp_messages", "column": "sender_phone", "value": BOT_PHONE, "should_exist": True},
        notes="Verify bot reply is logged to whatsapp_messages with sender_phone=BOT_PHONE",
    ))

    # ── Forward-to-Task (Option 1 Task 11) ──
    # All forward tests go through the 1:1 path (DM chat_id) because the
    # forward short-circuit only fires in handleDirectMessage. Group forwards
    # fall through to the normal classifier (by design — see Task 11 commit).
    #
    # These cases bypass Haiku classification entirely (classification_data is
    # null on 1:1), so expected_intent=None. We rely on reply_pattern + db_check.

    cases.append(TestCase(
        "forward_meeting_with_time", "Forward",
        "פגישה מחר בשעה 15:00 עם רינה בקפה ארומה",
        chat_id=TEST_DM_ID,
        forwarded=True,
        reply_pattern=r"תזכורת נשמרה|⏰",
        db_check={"table": "reminder_queue", "column": "message_text", "value": "רינה"},
        notes="Forward with explicit date+time → reminder_queue (not tasks)",
    ))

    cases.append(TestCase(
        "forward_shopping_list_no_time", "Forward",
        "חלב\nביצים\nלחם\nעגבניות\nגבינה צהובה",
        chat_id=TEST_DM_ID,
        forwarded=True,
        reply_pattern=r"הוספתי.*✅",
        db_check={"table": "tasks", "column": "source", "value": "forward"},
        notes="Forward a list without time → tasks with source=forward",
    ))

    cases.append(TestCase(
        "forward_reminder_to_call", "Forward",
        "אל תשכחו להתקשר לרופא השבוע",
        chat_id=TEST_DM_ID,
        forwarded=True,
        reply_pattern=r"הוספתי|תזכורת נשמרה",
        db_check=None,  # accepts either task or reminder depending on Haiku's week-level resolution
        notes="Forward 'remind to call doctor this week' → task OR reminder (Haiku's call)",
    ))

    cases.append(TestCase(
        "forward_non_actionable_greeting", "Forward",
        "בוקר טוב מרחוק, שיהיה לכם יום נפלא 🌞☕ שבת שלום!",
        chat_id=TEST_DM_ID,
        forwarded=True,
        reply_pattern=r"הודעה מעניינת|לא ברור",
        db_check=None,
        notes="Forward of generic greeting/meme → polite decline, no DB write",
    ))

    cases.append(TestCase(
        "forward_regression_non_forwarded_dm", "Forward",
        "תוסיפי חלב לרשימה",
        chat_id=TEST_DM_ID,
        forwarded=False,  # NOT forwarded — must still reach normal Sonnet 1:1 path
        reply_pattern=r"הוספתי|חלב",
        db_check=None,  # Just verifies reply; DB state varies with Sonnet routing
        notes="Regression: non-forwarded 1:1 still reaches Sonnet (forward branch didn't break normal flow)",
    ))

    return cases

# ─── Test Runner ───

def run_test(tc):
    """Run a single test case. Always runs teardown (if any), even on failure."""
    try:
        _run_test_inner(tc)
    finally:
        if tc.teardown:
            try:
                tc.teardown()
            except Exception as e:
                # Don't override a pre-existing failure with a teardown error.
                if tc.result not in ("fail", "error"):
                    tc.result = "error"
                    tc.detail = f"Teardown failed: {e}"

def _run_test_inner(tc):
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

    # Send webhook — honors per-case chat_id + forwarded flag
    status, body = send_webhook(
        tc.message,
        msg_id=msg_id,
        group_id=tc.chat_id,
        forwarded=tc.forwarded,
    )
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

    # Check expected_classification if specified (match the raw whatsapp_messages.classification field)
    if tc.expected_classification:
        actual_cls = logged.get("classification")
        if actual_cls != tc.expected_classification:
            tc.result = "fail"
            tc.detail = f"Expected classification '{tc.expected_classification}', got '{actual_cls}'"
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
            # Include confidence + addressed_to_bot for diagnostics
            diag = ""
            if cd:
                diag = f" conf={cd.get('confidence','?')} atb={cd.get('addressed_to_bot','?')}"
            tc.result = "fail"
            tc.detail = f"Expected '{tc.expected_intent}', got '{actual_intent}'{diag} (cls: {logged.get('classification')})"
            return

    # Check expected living_vs_operating (Phase 5.1)
    if tc.expected_living_vs_operating:
        actual_layer = (cd or {}).get("living_vs_operating")
        if actual_layer != tc.expected_living_vs_operating:
            tc.result = "fail"
            tc.detail = f"Expected living_vs_operating '{tc.expected_living_vs_operating}', got '{actual_layer}' (cd: {cd})"
            return

    # Check bot reply if pattern specified
    reply_for_neg_check = None
    if tc.reply_pattern:
        reply = poll_for_bot_reply(log_lookup_id(tc.chat_id), before_ts, timeout=15)
        if not reply:
            tc.result = "fail"
            tc.detail = f"No bot reply found (expected pattern: {tc.reply_pattern})"
            return
        if not re.search(tc.reply_pattern, reply.get("message_text", ""), re.IGNORECASE):
            tc.result = "fail"
            tc.detail = f"Reply didn't match pattern '{tc.reply_pattern}': {reply['message_text'][:100]}"
            return
        reply_for_neg_check = reply

    # Check that bot reply does NOT match forbidden pattern
    if tc.negative_reply_pattern:
        reply = reply_for_neg_check or poll_for_bot_reply(log_lookup_id(tc.chat_id), before_ts, timeout=15)
        if reply and re.search(tc.negative_reply_pattern, reply.get("message_text", ""), re.IGNORECASE):
            tc.result = "fail"
            tc.detail = f"Reply matched FORBIDDEN pattern '{tc.negative_reply_pattern}': {reply['message_text'][:100]}"
            return

    # Check DB state if specified (extra delay for Sonnet escalation path)
    if tc.db_check:
        time.sleep(3)  # action execution may still be in flight after classification is logged
        # Two modes: "column" uses ilike pattern match (text fields),
        # "field" uses exact value match (numeric/enum fields like expenses)
        if "field" in tc.db_check:
            ok, err = check_db_item_exact(
                tc.db_check["table"],
                TEST_HOUSEHOLD_ID,
                tc.db_check["field"],
                tc.db_check["value"],
            )
        else:
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

    # Parse --category filter
    filter_category = None
    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--category" and i < len(sys.argv) - 1:
            filter_category = sys.argv[i + 1]

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"\n{'='*60}")
    print(f"  Sheli Integration Tests")
    if filter_category:
        print(f"  Category filter: {filter_category}")
    print(f"  {now_str}")
    print(f"  Webhook: {WEBHOOK_URL}")
    print(f"  Test phone: {TEST_PHONE}")
    print(f"{'='*60}\n")

    # Build test cases
    cases = build_test_cases()

    # Filter by category if specified
    if filter_category:
        cases = [tc for tc in cases if tc.category.lower() == filter_category.lower()]
        if not cases:
            print(f"  ERROR: No test cases in category '{filter_category}'")
            all_cases = build_test_cases()
            cats = sorted(set(tc.category for tc in all_cases))
            print(f"  Available categories: {', '.join(cats)}")
            sys.exit(1)

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


# ─── Private DM Reminders (2026-04-22) — Integration Tests ────────────────────
#
# Uses unittest (not the TestCase framework above) because these cases need
# richer DB assertions (delivery_mode, recipient_phones, metadata.missing_phone_for)
# than check_db_item's ilike-pattern supports.
#
# Run: python -m unittest tests.test_webhook.TestPrivateDmReminders -v
# Prereq: Edge Function deployed with the Task 3-9 changes + drain v4 migration.

import unittest

DM_TEST_HOUSEHOLD_ID = "hh_dm_reminders_test"
DM_TEST_GROUP_CHAT_ID = "120363888888888888@g.us"
DM_TEST_SENDER_PHONE = "972500000100"
DM_TEST_SENDER_NAME = "ניב"
DM_PHONE_YONATAN = "972500000111"
DM_PHONE_EITAN = "972500000112"


def _dm_reset_household():
    for table in ["reminder_queue", "tasks", "shopping_items", "events", "whatsapp_messages"]:
        try:
            sb_delete(table, {"household_id": f"eq.{DM_TEST_HOUSEHOLD_ID}"})
        except Exception:
            pass
    for table, params in [
        ("rotations", {"household_id": f"eq.{DM_TEST_HOUSEHOLD_ID}"}),
        ("whatsapp_config", {"group_id": f"eq.{DM_TEST_GROUP_CHAT_ID}"}),
        ("whatsapp_member_mapping", {"household_id": f"eq.{DM_TEST_HOUSEHOLD_ID}"}),
        ("household_members", {"household_id": f"eq.{DM_TEST_HOUSEHOLD_ID}"}),
        ("households_v2", {"id": f"eq.{DM_TEST_HOUSEHOLD_ID}"}),
    ]:
        try:
            sb_delete(table, params)
        except Exception:
            pass


def _dm_create_household():
    sb_post("households_v2", {"id": DM_TEST_HOUSEHOLD_ID, "name": "DM Test Family", "lang": "he"})
    sb_post("whatsapp_config", {
        "group_id": DM_TEST_GROUP_CHAT_ID,
        "household_id": DM_TEST_HOUSEHOLD_ID,
        "bot_active": True,
        "language": "he",
        "group_message_count": 50,
    })


def _dm_create_member(name, phone=None, gender="male"):
    sb_post("household_members", {
        "household_id": DM_TEST_HOUSEHOLD_ID,
        "display_name": name,
        "gender": gender,
    })
    if phone:
        sb_post("whatsapp_member_mapping", {
            "household_id": DM_TEST_HOUSEHOLD_ID,
            "phone_number": phone,
            "member_name": name,
        })


def _dm_send(text, msg_id=None):
    if msg_id is None:
        msg_id = generate_msg_id("dm")
    send_webhook(text, msg_id=msg_id, sender_phone=DM_TEST_SENDER_PHONE, group_id=DM_TEST_GROUP_CHAT_ID)
    time.sleep(5)  # let Sonnet + rescue path complete
    return msg_id


def _dm_fetch_reminders(recurring_only=False):
    params = {
        "household_id": f"eq.{DM_TEST_HOUSEHOLD_ID}",
        "select": "id,message_text,delivery_mode,recipient_phones,recurrence,sent,metadata,send_at",
        "order": "send_at.desc",
        "limit": "50",
    }
    if recurring_only:
        params["recurrence"] = "not.is.null"
    return sb_get("reminder_queue", params)


def _dm_poll_bot_reply_text(msg_id, timeout=15):
    """Return the bot's reply message_text for the most recent bot message
    in the test group after msg_id was sent. Returns '' if no reply found."""
    # Poll for any bot reply in test group within timeout window
    deadline = time.time() + timeout
    after_iso = datetime.now(timezone.utc).isoformat()
    # use a slightly-in-past cutoff so our just-sent msg counts
    after_iso = (datetime.now(timezone.utc) - timedelta(seconds=15)).isoformat()
    while time.time() < deadline:
        rows = sb_get("whatsapp_messages", {
            "group_id": f"eq.{DM_TEST_GROUP_CHAT_ID}",
            "sender_phone": f"eq.{BOT_PHONE}",
            "created_at": f"gt.{after_iso}",
            "select": "message_text,created_at",
            "order": "created_at.desc",
            "limit": "1",
        })
        if rows:
            return rows[0].get("message_text") or ""
        time.sleep(2)
    return ""


@unittest.skipUnless(SUPABASE_URL and SUPABASE_KEY, "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required")
class TestPrivateDmReminders(unittest.TestCase):
    """Integration tests — private DM reminders (2026-04-22).
    Requires deployed Edge Function with fan-out support."""

    @classmethod
    def setUpClass(cls):
        _dm_reset_household()
        _dm_create_household()
        _dm_create_member(DM_TEST_SENDER_NAME, DM_TEST_SENDER_PHONE, "male")
        _dm_create_member("יונתן", DM_PHONE_YONATAN, "male")
        _dm_create_member("איתן", DM_PHONE_EITAN, "male")
        _dm_create_member("נגה", None, "female")  # intentionally no phone

    @classmethod
    def tearDownClass(cls):
        _dm_reset_household()

    def setUp(self):
        # Clear reminder_queue between tests to isolate assertions
        try:
            sb_delete("reminder_queue", {"household_id": f"eq.{DM_TEST_HOUSEHOLD_ID}"})
        except Exception:
            pass

    def test_01_self_dm_reminder(self):
        _dm_send("תזכירי לי בפרטי לשלם חשבון חמישי ב-10")
        rows = _dm_fetch_reminders()
        self.assertGreaterEqual(len(rows), 1, "expected at least one reminder row")
        dm_rows = [r for r in rows if r.get("delivery_mode") == "dm"]
        self.assertGreaterEqual(len(dm_rows), 1, f"expected dm row, got {rows}")
        self.assertEqual(dm_rows[0]["recipient_phones"], [DM_TEST_SENDER_PHONE])

    def test_02_third_person_both(self):
        _dm_send("תזכירי ליונתן גם בפרטי לשטוף כלים רביעי 7 בבוקר")
        rows = _dm_fetch_reminders()
        self.assertGreaterEqual(len(rows), 1)
        both_rows = [r for r in rows if r.get("delivery_mode") == "both"]
        self.assertGreaterEqual(len(both_rows), 1, f"expected both row, got {rows}")
        self.assertIn(DM_PHONE_YONATAN, both_rows[0]["recipient_phones"])

    def test_03_rotation_all_mapped(self):
        # Seed rotation first
        sb_post("rotations", {
            "id": f"rot_dm_test_{uuid.uuid4().hex[:8]}",
            "household_id": DM_TEST_HOUSEHOLD_ID,
            "title": "שטיפת כלים",
            "type": "duty",
            "members": ["יונתן", "איתן"],
            "current_index": 0,
            "frequency": {"type": "weekly", "days": ["wed", "thu"]},
            "active": True,
        })
        time.sleep(1)
        _dm_send("תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7")
        parents = _dm_fetch_reminders(recurring_only=True)
        dm_parents = [p for p in parents if p.get("delivery_mode") == "dm"]
        self.assertGreaterEqual(len(dm_parents), 2, f"expected 2+ dm recurring rows, got {parents}")
        for p in dm_parents:
            self.assertIsNotNone(p.get("recipient_phones"))
            self.assertEqual(len(p["recipient_phones"]), 1)

    def test_04_rotation_missing_phone(self):
        sb_post("rotations", {
            "id": f"rot_dm_test_{uuid.uuid4().hex[:8]}",
            "household_id": DM_TEST_HOUSEHOLD_ID,
            "title": "שטיפת כלים",
            "type": "duty",
            "members": ["יונתן", "איתן", "נגה"],
            "current_index": 0,
            "frequency": {"type": "weekly", "days": ["wed", "thu", "fri"]},
            "active": True,
        })
        time.sleep(1)
        msg_id = _dm_send("תזכירי לילדים בתורנות בפרטי לשטוף כלים כל יום ב-7")
        reply = _dm_poll_bot_reply_text(msg_id)
        self.assertTrue("נגה" in reply or "בקבוצה" in reply,
                        f"expected fallback mentioning נגה or בקבוצה; got: {reply!r}")
        parents = _dm_fetch_reminders(recurring_only=True)
        dm_rows = [p for p in parents if p.get("delivery_mode") == "dm"]
        group_rows = [p for p in parents
                      if p.get("delivery_mode") == "group"
                      and (p.get("metadata") or {}).get("missing_phone_for") == "נגה"]
        self.assertGreaterEqual(len(dm_rows), 2, f"expected 2+ dm rows, got {parents}")
        self.assertGreaterEqual(len(group_rows), 1, f"expected 1+ group fallback row, got {parents}")

    def test_05_single_unknown_refuses(self):
        msg_id = _dm_send("תזכירי לנגה בפרטי מחר ב-9")
        reply = _dm_poll_bot_reply_text(msg_id)
        self.assertIn("אין לי את הטלפון של נגה", reply,
                      f"expected refuse reply mentioning נגה; got: {reply!r}")
        rows = _dm_fetch_reminders()
        # No dm rows referencing נגה should be created
        for r in rows:
            phones = r.get("recipient_phones") or []
            self.assertNotIn("נגה", str(r.get("message_text", "")),
                             f"unexpected row for נגה: {r}")

    def test_06_explicit_group_override(self):
        _dm_send("תזכירי ביום חמישי במשפחתי להביא שמיכות")
        rows = _dm_fetch_reminders()
        self.assertGreaterEqual(len(rows), 1)
        blanket_row = next((r for r in rows if "שמיכות" in (r.get("message_text") or "")), None)
        self.assertIsNotNone(blanket_row, f"no row matching 'שמיכות' in {rows}")
        self.assertEqual(blanket_row.get("delivery_mode") or "group", "group")
        self.assertIsNone(blanket_row.get("recipient_phones"))

    def test_07_legacy_no_privacy_word(self):
        _dm_send("תזכירי לי מחר ב-10 להתקשר לסבתא")
        rows = _dm_fetch_reminders()
        self.assertGreaterEqual(len(rows), 1)
        row = next((r for r in rows if "סבתא" in (r.get("message_text") or "")), None)
        self.assertIsNotNone(row, f"no row matching 'סבתא' in {rows}")
        self.assertEqual(row.get("delivery_mode") or "group", "group")

    def test_08_reconciliation_on_mapping_add(self):
        # Seed a group-fallback row for נגה (pass dicts directly — json.dumps causes
        # double-encoding that stores a JSON string into the jsonb column and breaks
        # `metadata->>'missing_phone_for'` lookups in the RPC).
        sb_post("reminder_queue", {
            "household_id": DM_TEST_HOUSEHOLD_ID,
            "group_id": DM_TEST_GROUP_CHAT_ID,
            "message_text": "נגה — לשטוף כלים",
            "send_at": datetime.now(timezone.utc).isoformat(),
            "sent": True,  # parent
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "reminder_type": "user",
            "delivery_mode": "group",
            "recurrence": {"days": [5], "time": "07:00"},
            "metadata": {"recurring_parent": True, "missing_phone_for": "נגה"},
        })
        # Add mapping + invoke reconciliation
        sb_post("whatsapp_member_mapping", {
            "household_id": DM_TEST_HOUSEHOLD_ID,
            "phone_number": "972500000113",
            "member_name": "נגה",
        })
        sb_rpc("upgrade_group_fallback_reminders", {
            "p_household_id": DM_TEST_HOUSEHOLD_ID,
            "p_member_name": "נגה",
            "p_phone": "972500000113",
        })
        rows = _dm_fetch_reminders(recurring_only=True)
        upgraded = [p for p in rows
                    if p.get("delivery_mode") == "dm"
                    and p.get("recipient_phones") == ["972500000113"]]
        self.assertGreaterEqual(len(upgraded), 1, f"expected upgraded row, got {rows}")
