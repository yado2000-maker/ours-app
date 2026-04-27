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


# ─── 1:1 reminder target group_id (2026-04-26 Netzer bug) — Integration Tests ─
#
# Bug: 1:1 path (execute1on1Actions, handlePersonalChannelMessage forward) was
# inserting reminder_queue rows with group_id = phone@s.whatsapp.net regardless
# of whether the household had a paired family group. Real-world impact:
# Einat Netzer asked "תזכירי לעופרי בקבוצה המשותפת" from her 1:1 with Sheli;
# the recurring reminders were inserted with Einat's 1:1 JID, so they would
# have fired into Einat's private DM, invisible to her daughter עופרי.
#
# Fix: resolve1on1ReminderGroupId() in index.inlined.ts defaults to the
# household's active whatsapp_config.group_id when paired, falls back to the
# phone JID only for 1:1-only households (no group ever connected).
#
# Run: python -m unittest tests.test_webhook.TestOneOnOneReminderTarget -v

NETZER_HOUSEHOLD_ID = "hh_netzer_test"
NETZER_SOLO_HOUSEHOLD_ID = "hh_netzer_solo_test"
NETZER_SENDER_PHONE = "972500000300"
NETZER_SOLO_SENDER_PHONE = "972500000301"
NETZER_SENDER_NAME = "עינת-טסט"
NETZER_FAMILY_GROUP_ID = "120363999999999999@g.us"
NETZER_DM_CHAT_ID = f"{NETZER_SENDER_PHONE}@s.whatsapp.net"
NETZER_SOLO_DM_CHAT_ID = f"{NETZER_SOLO_SENDER_PHONE}@s.whatsapp.net"


def _netzer_reset_all():
    for hh in (NETZER_HOUSEHOLD_ID, NETZER_SOLO_HOUSEHOLD_ID):
        for table in ["reminder_queue", "tasks", "shopping_items", "events", "whatsapp_messages"]:
            try:
                sb_delete(table, {"household_id": f"eq.{hh}"})
            except Exception:
                pass
        for table, params in [
            ("whatsapp_member_mapping", {"household_id": f"eq.{hh}"}),
            ("household_members", {"household_id": f"eq.{hh}"}),
            ("households_v2", {"id": f"eq.{hh}"}),
        ]:
            try:
                sb_delete(table, params)
            except Exception:
                pass
    for params in [
        {"phone": f"eq.{NETZER_SENDER_PHONE}"},
        {"phone": f"eq.{NETZER_SOLO_SENDER_PHONE}"},
    ]:
        try:
            sb_delete("onboarding_conversations", params)
        except Exception:
            pass
    try:
        sb_delete("whatsapp_config", {"group_id": f"eq.{NETZER_FAMILY_GROUP_ID}"})
    except Exception:
        pass


def _netzer_create_paired_household():
    """Household WITH a paired family group — reminders should target the group."""
    sb_post("households_v2", {"id": NETZER_HOUSEHOLD_ID, "name": "Netzer Test Family", "lang": "he"})
    sb_post("whatsapp_config", {
        "group_id": NETZER_FAMILY_GROUP_ID,
        "household_id": NETZER_HOUSEHOLD_ID,
        "bot_active": True,
        "first_message_at": datetime.now(timezone.utc).isoformat(),
    })
    sb_post("household_members", {
        "household_id": NETZER_HOUSEHOLD_ID,
        "display_name": NETZER_SENDER_NAME,
        "gender": "female",
    })
    sb_post("whatsapp_member_mapping", {
        "household_id": NETZER_HOUSEHOLD_ID,
        "phone_number": NETZER_SENDER_PHONE,
        "member_name": NETZER_SENDER_NAME,
    })
    sb_post("onboarding_conversations", {
        "phone": NETZER_SENDER_PHONE,
        "state": "chatting",
        "household_id": NETZER_HOUSEHOLD_ID,
        "message_count": 10,
        "nudge_count": 0,
        "tried_capabilities": ["reminder"],
        "context": json.dumps({"name": NETZER_SENDER_NAME, "gender": "female"}),
    })


def _netzer_create_solo_household():
    """Household WITHOUT a paired group — reminders should fall back to phone JID."""
    sb_post("households_v2", {"id": NETZER_SOLO_HOUSEHOLD_ID, "name": "Netzer Solo Test", "lang": "he"})
    sb_post("household_members", {
        "household_id": NETZER_SOLO_HOUSEHOLD_ID,
        "display_name": "סולו-טסט",
        "gender": "female",
    })
    sb_post("whatsapp_member_mapping", {
        "household_id": NETZER_SOLO_HOUSEHOLD_ID,
        "phone_number": NETZER_SOLO_SENDER_PHONE,
        "member_name": "סולו-טסט",
    })
    sb_post("onboarding_conversations", {
        "phone": NETZER_SOLO_SENDER_PHONE,
        "state": "chatting",
        "household_id": NETZER_SOLO_HOUSEHOLD_ID,
        "message_count": 10,
        "nudge_count": 0,
        "tried_capabilities": ["reminder"],
        "context": json.dumps({"name": "סולו-טסט", "gender": "female"}),
    })


def _netzer_send(text, phone, chat_id, msg_id=None):
    if msg_id is None:
        msg_id = generate_msg_id("netzer")
    send_webhook(text, msg_id=msg_id, sender_phone=phone, group_id=chat_id)
    time.sleep(8)
    return msg_id


def _netzer_fetch_reminders(household_id):
    return sb_get("reminder_queue", {
        "household_id": f"eq.{household_id}",
        "select": "id,group_id,message_text,send_at,sent,delivery_mode,recurrence,metadata,created_at",
        "order": "created_at.desc",
        "limit": "50",
    })


class TestOneOnOneReminderTarget(unittest.TestCase):
    """Integration tests — 1:1-authored reminders target the family group when paired.

    Pre-fix: every 1:1 reminder INSERT hardcoded `phone@s.whatsapp.net`, so a
    user in 1:1 with Sheli could not produce a reminder visible to their family.
    """

    @classmethod
    def setUpClass(cls):
        _netzer_reset_all()
        _netzer_create_paired_household()
        _netzer_create_solo_household()

    @classmethod
    def tearDownClass(cls):
        _netzer_reset_all()

    def setUp(self):
        for hh in (NETZER_HOUSEHOLD_ID, NETZER_SOLO_HOUSEHOLD_ID):
            try:
                sb_delete("reminder_queue", {"household_id": f"eq.{hh}"})
            except Exception:
                pass

    def test_01_one_shot_reminder_paired_household_targets_group(self):
        """1:1 user with paired family group → one-shot reminder fires into group."""
        _netzer_send(
            "תזכירי מחר ב-9 בבוקר לקחת תרופה לכלב",
            NETZER_SENDER_PHONE,
            NETZER_DM_CHAT_ID,
        )
        rows = _netzer_fetch_reminders(NETZER_HOUSEHOLD_ID)
        self.assertGreaterEqual(len(rows), 1, f"expected reminder row, got {rows}")
        # The bug was rows[*].group_id == "972500000300@s.whatsapp.net".
        # Post-fix: rows[*].group_id == NETZER_FAMILY_GROUP_ID.
        targeting_group = [r for r in rows if r.get("group_id") == NETZER_FAMILY_GROUP_ID]
        self.assertGreaterEqual(
            len(targeting_group), 1,
            f"reminder should target family group {NETZER_FAMILY_GROUP_ID}, got group_ids "
            f"{[r.get('group_id') for r in rows]}",
        )
        self.assertNotEqual(
            targeting_group[0].get("group_id"), NETZER_DM_CHAT_ID,
            "reminder targeted speaker's 1:1 JID — bug regressed",
        )
        self.assertEqual(targeting_group[0].get("delivery_mode"), "group")

    def test_02_recurring_reminder_paired_household_targets_group(self):
        """1:1 user with paired family group → recurring reminder parent targets group."""
        _netzer_send(
            "תזכירי כל יום ב-9 בבוקר לקחת תרופה לכלב",
            NETZER_SENDER_PHONE,
            NETZER_DM_CHAT_ID,
        )
        rows = _netzer_fetch_reminders(NETZER_HOUSEHOLD_ID)
        recurring = [r for r in rows if (r.get("recurrence") or {})]
        self.assertGreaterEqual(
            len(recurring), 1, f"expected recurring parent, got {rows}",
        )
        targeting_group = [r for r in recurring if r.get("group_id") == NETZER_FAMILY_GROUP_ID]
        self.assertGreaterEqual(
            len(targeting_group), 1,
            f"recurring parent should target family group, got group_ids "
            f"{[r.get('group_id') for r in recurring]}",
        )
        self.assertEqual(targeting_group[0].get("delivery_mode"), "group")

    def test_03_solo_household_falls_back_to_phone_jid(self):
        """1:1-only household (no paired group) → reminder falls back to phone JID, dm mode."""
        _netzer_send(
            "תזכירי לי מחר ב-10 לבדוק את המייל",
            NETZER_SOLO_SENDER_PHONE,
            NETZER_SOLO_DM_CHAT_ID,
        )
        rows = _netzer_fetch_reminders(NETZER_SOLO_HOUSEHOLD_ID)
        self.assertGreaterEqual(len(rows), 1, f"expected reminder row, got {rows}")
        # No paired group → must fall back to phone JID so the reminder still
        # fires somewhere the speaker will see it.
        targeting_phone = [r for r in rows if r.get("group_id") == NETZER_SOLO_DM_CHAT_ID]
        self.assertGreaterEqual(
            len(targeting_phone), 1,
            f"solo-household reminder should fall back to phone JID, got group_ids "
            f"{[r.get('group_id') for r in rows]}",
        )
        self.assertEqual(targeting_phone[0].get("delivery_mode"), "dm")


# ─── Reminder Triple-Fire Dedup (2026-04-24) — Integration Tests ──────────────
#
# Covers three bugs from docs/plans/2026-04-24-reminder-triple-fire-handoff.md:
#   Bug 1 — rescueRemindersAndStrip + action-path both INSERT on same Sonnet reply
#   Bug 2 — "וגם את אלה תזכירי?" 49 min later inserts duplicate rows
#   Bug 3 — handleCorrection v2 only cancels single target_id on bulk correction
#
# Run: python -m unittest tests.test_webhook.TestReminderDedup -v

DEDUP_HOUSEHOLD_ID = "hh_reminder_dedup_test"
DEDUP_SENDER_PHONE = "972500000200"
DEDUP_SENDER_NAME = "עדי-טסט"
DEDUP_DM_CHAT_ID = f"{DEDUP_SENDER_PHONE}@s.whatsapp.net"
# The 1:1 path stores `group_id` as the bare phone in whatsapp_messages
# but as the full JID in reminder_queue. Reset covers both shapes.


def _dedup_reset_household():
    for table in ["reminder_queue", "tasks", "shopping_items", "events", "whatsapp_messages"]:
        try:
            sb_delete(table, {"household_id": f"eq.{DEDUP_HOUSEHOLD_ID}"})
        except Exception:
            pass
    for table, params in [
        ("onboarding_conversations", {"phone": f"eq.{DEDUP_SENDER_PHONE}"}),
        ("whatsapp_member_mapping", {"household_id": f"eq.{DEDUP_HOUSEHOLD_ID}"}),
        ("household_members", {"household_id": f"eq.{DEDUP_HOUSEHOLD_ID}"}),
        ("households_v2", {"id": f"eq.{DEDUP_HOUSEHOLD_ID}"}),
    ]:
        try:
            sb_delete(table, params)
        except Exception:
            pass


def _dedup_create_household():
    sb_post("households_v2", {"id": DEDUP_HOUSEHOLD_ID, "name": "Dedup Test Family", "lang": "he"})
    sb_post("household_members", {
        "household_id": DEDUP_HOUSEHOLD_ID,
        "display_name": DEDUP_SENDER_NAME,
        "gender": "female",
    })
    sb_post("whatsapp_member_mapping", {
        "household_id": DEDUP_HOUSEHOLD_ID,
        "phone_number": DEDUP_SENDER_PHONE,
        "member_name": DEDUP_SENDER_NAME,
    })
    sb_post("onboarding_conversations", {
        "phone": DEDUP_SENDER_PHONE,
        "state": "chatting",
        "household_id": DEDUP_HOUSEHOLD_ID,
        "message_count": 10,
        "nudge_count": 0,
        "tried_capabilities": ["reminder"],
        "context": json.dumps({"name": DEDUP_SENDER_NAME, "gender": "female"}),
    })


def _dedup_send(text, msg_id=None):
    if msg_id is None:
        msg_id = generate_msg_id("dedup")
    # 1:1 path — chat_id = phone@s.whatsapp.net. This is the code path Adi hit.
    send_webhook(text, msg_id=msg_id, sender_phone=DEDUP_SENDER_PHONE, group_id=DEDUP_DM_CHAT_ID)
    time.sleep(8)
    return msg_id


def _dedup_fetch_reminders(pending_only=True):
    params = {
        "household_id": f"eq.{DEDUP_HOUSEHOLD_ID}",
        "select": "id,message_text,send_at,sent,delivery_mode,recipient_phones,metadata,created_at",
        "order": "created_at.desc",
        "limit": "50",
    }
    if pending_only:
        params["sent"] = "eq.false"
    return sb_get("reminder_queue", params)


def _dedup_poll_bot_reply(after_iso, timeout=20):
    deadline = time.time() + timeout
    # 1:1 messages: whatsapp_messages.group_id stores bare phone (see CLAUDE.md
    # "group_id format mismatch"). Poll for bot replies in that DM thread.
    while time.time() < deadline:
        rows = sb_get("whatsapp_messages", {
            "group_id": f"eq.{DEDUP_SENDER_PHONE}",
            "sender_phone": f"eq.{BOT_PHONE}",
            "created_at": f"gt.{after_iso}",
            "select": "message_text,created_at",
            "order": "created_at.desc",
            "limit": "3",
        })
        if rows:
            return rows[0].get("message_text") or ""
        time.sleep(2)
    return ""


# ─── Nudge Reminders (state-machine reminders, 2026-04-26) ───────────────────
NUDGE_TEST_HOUSEHOLD_ID = "hh_nudge_reminders_test"
NUDGE_TEST_GROUP_CHAT_ID = "120363777777777777@g.us"
NUDGE_TEST_SENDER_PHONE = "972500000200"
NUDGE_TEST_SENDER_NAME = "עינת"
NUDGE_PHONE_OFRI = "972500000211"
NUDGE_PHONE_ARIK = "972500000212"


def _nudge_reset_household():
    for table in ["reminder_queue", "tasks", "shopping_items", "events", "whatsapp_messages"]:
        try:
            sb_delete(table, {"household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}"})
        except Exception:
            pass
    for table, params in [
        ("whatsapp_config", {"group_id": f"eq.{NUDGE_TEST_GROUP_CHAT_ID}"}),
        ("whatsapp_member_mapping", {"household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}"}),
        ("household_members", {"household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}"}),
        ("households_v2", {"id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}"}),
    ]:
        try:
            sb_delete(table, params)
        except Exception:
            pass


def _nudge_create_household():
    sb_post("households_v2", {"id": NUDGE_TEST_HOUSEHOLD_ID, "name": "Nudge Test Family", "lang": "he"})
    sb_post("whatsapp_config", {
        "group_id": NUDGE_TEST_GROUP_CHAT_ID,
        "household_id": NUDGE_TEST_HOUSEHOLD_ID,
        "bot_active": True,
        "language": "he",
        "group_message_count": 50,
    })


def _nudge_create_member(name, phone=None, gender="male"):
    sb_post("household_members", {
        "household_id": NUDGE_TEST_HOUSEHOLD_ID,
        "display_name": name,
        "gender": gender,
    })
    if phone:
        sb_post("whatsapp_member_mapping", {
            "household_id": NUDGE_TEST_HOUSEHOLD_ID,
            "phone_number": phone,
            "member_name": name,
        })


def _nudge_send(text, msg_id=None):
    if msg_id is None:
        msg_id = generate_msg_id("nudge")
    send_webhook(text, msg_id=msg_id, sender_phone=NUDGE_TEST_SENDER_PHONE, group_id=NUDGE_TEST_GROUP_CHAT_ID)
    return msg_id


@unittest.skipUnless(SUPABASE_URL and SUPABASE_KEY, "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required")
class TestNudgeReminders(unittest.TestCase):
    """Integration tests — nudge reminders (2026-04-26).

    Phase 2 Task 2.2 covers HAIKU CLASSIFICATION ONLY (intent + entities).
    End-to-end DB writes + sub-floor refusal templates land in Task 2.5
    after the executor + SHARED_NUDGE_RULES ship (Tasks 2.3 + 2.4).

    Requires deployed Edge Function with the Phase 2 Task 2.1 changes:
      - 'add_nudge_reminder' added to ClassificationOutput.intent union
      - nudge_* entity fields on ClassificationOutput.entities
      - NUDGE VOCABULARY rules + 6 examples in the Haiku prompt
    """

    @classmethod
    def setUpClass(cls):
        _nudge_reset_household()
        _nudge_create_household()
        _nudge_create_member(NUDGE_TEST_SENDER_NAME, NUDGE_TEST_SENDER_PHONE, "female")
        _nudge_create_member("עופרי", NUDGE_PHONE_OFRI, "female")
        _nudge_create_member("אריק", NUDGE_PHONE_ARIK, "male")

    @classmethod
    def tearDownClass(cls):
        _nudge_reset_household()

    def setUp(self):
        try:
            sb_delete("reminder_queue", {"household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}"})
        except Exception:
            pass

    def _classify(self, text):
        msg_id = _nudge_send(text)
        row = poll_for_message(msg_id, timeout=20)
        self.assertIsNotNone(row, f"no classification row for msg_id={msg_id}, text={text!r}")
        cd = row.get("classification_data") or {}
        return cd, row

    def test_01_classifies_simple_nudge_with_target_and_interval(self):
        cd, _ = self._classify("שלי תזכירי לעופרי כל חצי שעה עד שתוציא את ליאו")
        self.assertEqual(cd.get("intent"), "add_nudge_reminder",
                         f"expected add_nudge_reminder, got {cd.get('intent')}; full={cd}")
        ent = cd.get("entities") or {}
        self.assertEqual(ent.get("nudge_interval_min"), 30,
                         f"expected interval_min=30 (חצי שעה), got {ent.get('nudge_interval_min')}; full={ent}")
        self.assertEqual(ent.get("nudge_target_name"), "עופרי",
                         f"expected target_name=עופרי, got {ent.get('nudge_target_name')}; full={ent}")

    def test_02_classifies_short_interval_nudge(self):
        cd, _ = self._classify("שלי כל 15 דק תזכירי לי לבדוק את התנור")
        self.assertEqual(cd.get("intent"), "add_nudge_reminder",
                         f"expected add_nudge_reminder, got {cd.get('intent')}; full={cd}")
        ent = cd.get("entities") or {}
        self.assertEqual(ent.get("nudge_interval_min"), 15,
                         f"expected interval_min=15, got {ent.get('nudge_interval_min')}; full={ent}")

    def test_03_classifies_with_deadline(self):
        cd, _ = self._classify("שלי נדנדי לי כל חצי שעה עד 22:00 לקחת כדור")
        self.assertEqual(cd.get("intent"), "add_nudge_reminder",
                         f"expected add_nudge_reminder, got {cd.get('intent')}; full={cd}")
        ent = cd.get("entities") or {}
        self.assertEqual(ent.get("nudge_deadline_time_il"), "22:00",
                         f"expected deadline_time_il=22:00, got {ent.get('nudge_deadline_time_il')}; full={ent}")

    # End-to-end DB write — verifies the executor + SHARED_NUDGE_RULES + drain
    # extension all work together. Sonnet must (a) emit a NUDGE_SERIES block,
    # (b) the rescue must INSERT the anchor + attempt #1 into reminder_queue.
    #
    # Trigger phrasing matters: "עד 23:30" (wall-clock) flips the discriminator
    # to add_recurring_reminder per SHARED_NUDGE_RULES. We use "נדנדי" which is
    # an unambiguous nudge verb regardless of the "עד" suffix shape.
    def test_04_one_shot_creates_anchor_and_attempt(self):
        msg_id = _nudge_send(
            "שלי נדנדי לעופרי כל 30 דק עד שיוציא את הזבל"
        )
        # 5s typical Sonnet+rescue latency (matches _dm_send timing).
        time.sleep(8)
        rows = sb_get("reminder_queue", {
            "household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}",
            "select": "id,nudge_config,series_status,nudge_series_id,nudge_attempt,sent,message_text,send_at,recurrence",
            "order": "created_at.desc",
            "limit": "10",
        })
        anchors = [r for r in rows if r.get("nudge_config") and r.get("series_status") == "active"]
        attempts = [r for r in rows if r.get("nudge_series_id") and r.get("nudge_attempt") == 1]
        # Surface what DID get classified if no nudge row landed — helps
        # diagnose Sonnet emit issues (e.g. recurring_reminder fallback).
        if len(anchors) == 0:
            classified = sb_get("whatsapp_messages", {
                "whatsapp_message_id": f"eq.{msg_id}",
                "select": "classification,classification_data",
                "limit": "5",
            })
            self.fail(
                f"expected 1+ active nudge anchor; reminder_queue rows={rows}; "
                f"whatsapp_messages classification={classified}"
            )
        self.assertGreaterEqual(len(attempts), 1,
                                f"expected 1+ attempt #1 row, got rows={rows}")
        cfg = anchors[0]["nudge_config"]
        self.assertEqual(cfg.get("interval_min"), 30,
                         f"expected interval_min=30, got {cfg}")
        self.assertEqual(cfg.get("target_name"), "עופרי",
                         f"expected target_name=עופרי, got {cfg}")

    # Sub-floor refusal — interval_min=5 must be rejected with the exact
    # SHARED_NUDGE_RULES template, AND no row may land in reminder_queue.
    # Defense-in-depth: SHARED_NUDGE_RULES tells Sonnet to emit only the
    # refusal text (no NUDGE_SERIES block); if Sonnet ignores that, the SQL
    # validate_nudge_config trigger raises nudge_interval_below_floor and
    # the executor catches → still surfaces the same refusal text. So this
    # test verifies BOTH the prompt path (template in reply) AND the DB
    # invariant (no nudge_config row).
    # Tier 1 ack via regex fast-path. Insert an anchor + attempt #1 directly
    # (skip Sonnet entirely so the test isolates the regex path), then send
    # 'בוצע' as a user message. Expect series_status='acked' + child cancelled.
    def test_06_regex_ack_flips_series_to_acked(self):
        # Seed an active series for עופרי
        anchor_id = sb_post("reminder_queue", {
            "household_id": NUDGE_TEST_HOUSEHOLD_ID,
            "group_id": NUDGE_TEST_GROUP_CHAT_ID,
            "message_text": "עופרי — לבדוק תנור",
            "send_at": datetime.now(timezone.utc).isoformat(),
            "sent": True,
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "reminder_type": "user",
            "created_by_phone": NUDGE_TEST_SENDER_PHONE,
            "created_by_name": NUDGE_TEST_SENDER_NAME,
            "delivery_mode": "group",
            "nudge_config": {
                "interval_min": 15, "max_tries": 6, "deadline_time_il": "23:59",
                "channel": "group", "target_phone": NUDGE_PHONE_OFRI,
                "target_name": "עופרי", "prompt_completion": "לבדוק תנור",
            },
            "series_status": "active",
            "metadata": {"source": "test_06_regex_ack_seed"},
        })[0]["id"]
        # Seed an unsent attempt #1
        sb_post("reminder_queue", {
            "household_id": NUDGE_TEST_HOUSEHOLD_ID,
            "group_id": NUDGE_TEST_GROUP_CHAT_ID,
            "message_text": "עופרי — לבדוק תנור",
            "send_at": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
            "sent": False,
            "reminder_type": "user",
            "created_by_phone": NUDGE_TEST_SENDER_PHONE,
            "delivery_mode": "group",
            "nudge_series_id": anchor_id,
            "nudge_attempt": 1,
            "metadata": {"nudge_attempt_of_series": anchor_id, "attempt_num": 1},
        })

        _nudge_send("בוצע, בדקתי")
        time.sleep(5)

        anchor_after = sb_get("reminder_queue", {
            "id": f"eq.{anchor_id}",
            "select": "series_status,metadata",
        })
        self.assertEqual(len(anchor_after), 1, f"anchor missing: {anchor_after}")
        self.assertEqual(anchor_after[0]["series_status"], "acked",
                         f"expected 'acked', got {anchor_after[0]}")

        unsent_attempts = sb_get("reminder_queue", {
            "nudge_series_id": f"eq.{anchor_id}",
            "sent": "eq.false",
            "select": "id,nudge_attempt",
        })
        self.assertEqual(len(unsent_attempts), 0,
                         f"expected 0 unsent attempts (all soft-cancelled), got {unsent_attempts}")

    # Deadline expiry: anchor with deadline_time_il in the past,
    # calling schedule_next_nudge transitions to expired_deadline.
    def test_07_deadline_expiry(self):
        # Hardcoded "01:00" IL — guaranteed to be in the past for any test
        # run after 1am. schedule_next_nudge computes today_at_il(01:00) which
        # is ~20+ hours in the past for an evening test run; next_send =
        # NOW + 15 min is far ahead of that, so the > comparison flips
        # series_status to expired_deadline. Avoids zoneinfo/tzdata dependency
        # on Windows test runners.
        past_min = "01:00"

        anchor_id = sb_post("reminder_queue", {
            "household_id": NUDGE_TEST_HOUSEHOLD_ID,
            "group_id": NUDGE_TEST_GROUP_CHAT_ID,
            "message_text": "עופרי — לבדוק תנור",
            "send_at": datetime.now(timezone.utc).isoformat(),
            "sent": True,
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "reminder_type": "user",
            "created_by_phone": NUDGE_TEST_SENDER_PHONE,
            "delivery_mode": "group",
            "nudge_config": {
                "interval_min": 15, "max_tries": 6, "deadline_time_il": past_min,
                "channel": "group", "target_phone": NUDGE_PHONE_OFRI,
                "target_name": "עופרי", "prompt_completion": "לבדוק תנור",
            },
            "series_status": "active",
            "metadata": {"source": "test_07_deadline_seed"},
        })[0]["id"]

        # Call schedule_next_nudge directly via PostgREST RPC
        sb_rpc("schedule_next_nudge", {"p_series_id": anchor_id})

        anchor_after = sb_get("reminder_queue", {
            "id": f"eq.{anchor_id}",
            "select": "series_status",
        })
        self.assertEqual(anchor_after[0]["series_status"], "expired_deadline",
                         f"expected 'expired_deadline', got {anchor_after}")

    # Max-tries expiry: insert anchor with max_tries=2 and 2 existing attempt
    # children, call schedule_next_nudge, expect expired_tries + outbound DM
    # queued by notify_expired_nudge_series().
    def test_08_max_tries_expiry_with_outbound(self):
        anchor_id = sb_post("reminder_queue", {
            "household_id": NUDGE_TEST_HOUSEHOLD_ID,
            "group_id": NUDGE_TEST_GROUP_CHAT_ID,
            "message_text": "עופרי — לבדוק תנור",
            "send_at": datetime.now(timezone.utc).isoformat(),
            "sent": True,
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "reminder_type": "user",
            "created_by_phone": NUDGE_TEST_SENDER_PHONE,
            "delivery_mode": "group",
            "nudge_config": {
                "interval_min": 15, "max_tries": 2, "deadline_time_il": "23:59",
                "channel": "group", "target_phone": NUDGE_PHONE_OFRI,
                "target_name": "עופרי", "prompt_completion": "לבדוק תנור",
            },
            "series_status": "active",
            "metadata": {"source": "test_08_max_tries_seed"},
        })[0]["id"]
        # Seed 2 already-sent attempts so max_tries=2 is exactly reached
        for i in (1, 2):
            sb_post("reminder_queue", {
                "household_id": NUDGE_TEST_HOUSEHOLD_ID,
                "group_id": NUDGE_TEST_GROUP_CHAT_ID,
                "message_text": "עופרי — לבדוק תנור",
                "send_at": (datetime.now(timezone.utc) - timedelta(minutes=30 - 15 * i)).isoformat(),
                "sent": True,
                "sent_at": (datetime.now(timezone.utc) - timedelta(minutes=30 - 15 * i)).isoformat(),
                "reminder_type": "user",
                "created_by_phone": NUDGE_TEST_SENDER_PHONE,
                "delivery_mode": "group",
                "nudge_series_id": anchor_id,
                "nudge_attempt": i,
                "metadata": {"nudge_attempt_of_series": anchor_id, "attempt_num": i},
            })

        # Call schedule_next_nudge: last_attempt=2 >= max_tries=2 → expired_tries
        sb_rpc("schedule_next_nudge", {"p_series_id": anchor_id})
        # Then run the expiry notifier — should queue one outbound nudge_expiry row
        sb_rpc("notify_expired_nudge_series", {})

        anchor_after = sb_get("reminder_queue", {
            "id": f"eq.{anchor_id}",
            "select": "series_status,metadata",
        })
        self.assertEqual(anchor_after[0]["series_status"], "expired_tries",
                         f"expected 'expired_tries', got {anchor_after}")
        self.assertIsNotNone(anchor_after[0]["metadata"].get("expiry_notified"),
                             f"expected metadata.expiry_notified breadcrumb; got {anchor_after[0]['metadata']}")

        outbound_rows = sb_get("outbound_queue", {
            "household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}",
            "message_type": "eq.nudge_expiry",
            "select": "phone_number,body,metadata",
            "order": "queued_at.desc",
            "limit": "5",
        })
        match = [r for r in outbound_rows if r.get("metadata", {}).get("series_id") == anchor_id]
        self.assertEqual(len(match), 1,
                         f"expected 1 outbound nudge_expiry row for series {anchor_id}; got {outbound_rows}")
        self.assertEqual(match[0]["phone_number"], NUDGE_TEST_SENDER_PHONE,
                         f"expected DM to requester {NUDGE_TEST_SENDER_PHONE}; got {match[0]['phone_number']}")
        # Cleanup: drop the outbound row so it doesn't sit in the queue
        sb_delete("outbound_queue", {"household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}", "message_type": "eq.nudge_expiry"})

    def test_05_sub_floor_interval_refused_no_db_row(self):
        msg_id = _nudge_send("שלי תזכירי לעופרי כל 5 דקות לבדוק תנור")
        # Bot reply should land within ~10s
        bot_reply = ""
        deadline = time.time() + 15
        after_iso = (datetime.now(timezone.utc) - timedelta(seconds=20)).isoformat()
        while time.time() < deadline:
            replies = sb_get("whatsapp_messages", {
                "group_id": f"eq.{NUDGE_TEST_GROUP_CHAT_ID}",
                "sender_phone": f"eq.{BOT_PHONE}",
                "created_at": f"gt.{after_iso}",
                "select": "message_text,created_at",
                "order": "created_at.desc",
                "limit": "1",
            })
            if replies:
                bot_reply = replies[0].get("message_text") or ""
                break
            time.sleep(2)
        # Either the prompt-side or the DB-side defense should trigger the
        # canonical refusal text. Accept either the full sentence or its
        # diagnostic prefix ("המינימום הוא 15 דקות").
        self.assertIn(
            "המינימום הוא 15 דקות", bot_reply,
            f"expected sub-floor refusal template; got reply: {bot_reply!r}"
        )
        # No nudge row should have been created.
        rows = sb_get("reminder_queue", {
            "household_id": f"eq.{NUDGE_TEST_HOUSEHOLD_ID}",
            "select": "id,nudge_config,message_text",
            "limit": "10",
        })
        nudge_rows = [r for r in rows if r.get("nudge_config")]
        self.assertEqual(
            len(nudge_rows), 0,
            f"sub-floor request must NOT create a nudge_config row; got: {nudge_rows}"
        )


@unittest.skipUnless(SUPABASE_URL and SUPABASE_KEY, "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required")
class TestReminderDedup(unittest.TestCase):
    """Integration tests — reminder triple-fire dedup (2026-04-24).
    Covers Bugs 1/2/3 from the handoff doc. Requires deployed Edge Function."""

    @classmethod
    def setUpClass(cls):
        _dedup_reset_household()
        _dedup_create_household()

    @classmethod
    def tearDownClass(cls):
        _dedup_reset_household()

    def setUp(self):
        try:
            sb_delete("reminder_queue", {"household_id": f"eq.{DEDUP_HOUSEHOLD_ID}"})
        except Exception:
            pass

    def test_A_single_message_single_row_per_reminder(self):
        """Bug 1 — one message with 4 reminders → exactly 4 rows (not 8).
        Under today's code, rescue + action both INSERT so we see 8."""
        _dedup_send("תזכירי לי מחר: ביס ב-8, חיסון ב-9, אוריאל ב-10, פירות ב-11")
        time.sleep(3)
        rows = _dedup_fetch_reminders(pending_only=True)
        # Each reminder = 1 row. 4 reminders total. Under bug, each duplicated → 8.
        self.assertLessEqual(
            len(rows), 5,
            f"expected ≤5 rows (4 reminders + slop), got {len(rows)} — Bug 1 likely present. rows={rows}"
        )
        self.assertGreaterEqual(
            len(rows), 3,
            f"expected ≥3 rows (4 reminders, allowing 1 slop), got {len(rows)}. rows={rows}"
        )

    def test_B_re_ask_does_not_duplicate(self):
        """Bug 2 — user re-asks 'וגם את אלה תזכירי?' → no new rows, just acknowledge."""
        _dedup_send("תזכירי לי מחר: ביס ב-8, חיסון ב-9")
        time.sleep(4)
        initial_rows = _dedup_fetch_reminders(pending_only=True)
        initial_count = len(initial_rows)
        self.assertGreaterEqual(initial_count, 1, f"setup failed: no initial reminders. rows={initial_rows}")

        after_iso = (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
        _dedup_send("וגם את אלה תזכירי?")
        time.sleep(4)
        final_rows = _dedup_fetch_reminders(pending_only=True)
        # Bug 2 check: no EXACT duplicates (same text + same send_at) — new distinct
        # items are allowed (Sonnet may expand context-free re-ask into inferred items).
        from collections import Counter
        initial_keys = Counter((r.get("message_text", ""), r.get("send_at", "")) for r in initial_rows)
        final_keys = Counter((r.get("message_text", ""), r.get("send_at", "")) for r in final_rows)
        dupes = {k: final_keys[k] for k in initial_keys if final_keys[k] > initial_keys[k]}
        self.assertEqual(
            dupes, {},
            f"Bug 2: re-ask duplicated existing (text, send_at) pairs: {dupes}. final={final_rows}"
        )
        reply = _dedup_poll_bot_reply(after_iso, timeout=15)
        # Bot should acknowledge existing — common Hebrew words for "already"/"scheduled".
        self.assertTrue(
            any(kw in reply for kw in ["כבר", "רשום", "רשמתי", "קיים", "מה", "תפרטו", "פרטו", "איזה"]),
            f"expected acknowledgement OR clarification reply; got: {reply!r}"
        )

    def test_C_bulk_correction_cancels_all_today(self):
        """Bug 3 — 'עשית בלגן, מחקי הכל' must soft-cancel every pending today row."""
        # Seed with retries — Haiku/Sonnet occasionally only materializes 1 of 3.
        _dedup_send("תזכירי לי היום: ביס ב-14, חיסון ב-15, אוריאל ב-16")
        time.sleep(5)
        initial_rows = _dedup_fetch_reminders(pending_only=True)
        if len(initial_rows) < 2:
            _dedup_send("תזכירי לי גם פירות ב-17 וגם ספרית ב-18")
            time.sleep(5)
            initial_rows = _dedup_fetch_reminders(pending_only=True)
        self.assertGreaterEqual(
            len(initial_rows), 2,
            f"setup failed: need ≥2 pending rows to test bulk cancel. rows={initial_rows}"
        )

        _dedup_send("עשית בלגן, מחקי הכל")
        time.sleep(5)
        pending_after = _dedup_fetch_reminders(pending_only=True)
        # Exclude any row created by the correction itself (a "redo" replacement batch).
        # Bug 3 success = every row that existed BEFORE the correction is now sent=true + superseded.
        initial_ids = {r["id"] for r in initial_rows}
        still_pending_from_initial = [r for r in pending_after if r["id"] in initial_ids]
        self.assertEqual(
            len(still_pending_from_initial), 0,
            f"Bug 3: {len(still_pending_from_initial)} of the {len(initial_rows)} original rows "
            f"were NOT soft-cancelled. survivors={still_pending_from_initial}"
        )

    def test_D_rescue_plus_action_dedups(self):
        """Bug 1 (variant) — single short reminder 'פירות 8:30' emits REMINDER block
        AND the action-path fires. Expect 1 row, not 2."""
        _dedup_send("תזכירי לי פירות מחר ב-8:30")
        time.sleep(4)
        rows = _dedup_fetch_reminders(pending_only=True)
        self.assertEqual(
            len(rows), 1,
            f"Bug 1 (rescue+action): expected exactly 1 row for 'פירות 8:30', got {len(rows)}. rows={rows}"
        )


# ─── Task 1: executeCrudAction helper regression test ───
# Baseline: the 1:1 update_shopping path (which drove the extraction) must not
# regress. Test is skipped until Task 7 deploy — runs in the Task 8 smoke sweep.

@unittest.skip("Task 1 refactor not deployed yet — un-skip in Task 7 smoke sweep")
class TestCrudHelper(unittest.TestCase):
    def test_01_update_shopping_still_works_1on1(self):
        # Sends via the 1:1 DM path to exercise executeCrudAction fuzzy branch.
        _dm_send("תוסיפי פסטה לרשימה")
        time.sleep(3)
        _dm_send("תתקני לפסטה פנה")
        time.sleep(3)
        params = {
            "household_id": f"eq.{DM_TEST_HOUSEHOLD_ID}",
            "got": "eq.false",
            "select": "name",
        }
        rows = sb_get("shopping_items", params) or []
        pasta_rows = [r for r in rows if "פסטה" in (r.get("name") or "")]
        self.assertEqual(len(pasta_rows), 1, f"expected one pasta row, got: {pasta_rows}")
        self.assertEqual(pasta_rows[0]["name"], "פסטה פנה")


# ─── Tasks 2-4: group-path correction (Sonnet-structured update/remove/clarify) ───
# All 8 cases stay @pytest.mark.skip until the Edge Function is deployed in Task 7.

# ─── TestCorrectBotV2 fixtures + helpers ───

TEST_PHONE_1 = TEST_PHONE  # reuse the authorized test phone
# Distinct fake group ids so each test seeds under its own household row.
TEST_GROUP_1 = "120363900000000001@g.us"
TEST_GROUP_2 = "120363900000000002@g.us"
TEST_GROUP_3 = "120363900000000003@g.us"
TEST_GROUP_4 = "120363900000000004@g.us"
TEST_GROUP_5 = "120363900000000005@g.us"
TEST_GROUP_6 = "120363900000000006@g.us"
TEST_GROUP_7 = "120363900000000007@g.us"
TEST_GROUP_8 = "120363900000000008@g.us"


def send_group_message(group_id, phone, text):
    return send_webhook(text, sender_phone=phone, group_id=group_id)


def fetch_household_for_group(group_id):
    rows = sb_get("whatsapp_config", {
        "group_id": f"eq.{group_id}",
        "select": "household_id",
        "limit": "1",
    }) or []
    return rows[0]["household_id"] if rows else None


def fetch_events_for_group(group_id, since_minutes=5):
    hhid = fetch_household_for_group(group_id)
    if not hhid:
        return []
    since = (datetime.now(timezone.utc) - timedelta(minutes=since_minutes)).isoformat()
    rows = sb_get("events", {
        "household_id": f"eq.{hhid}",
        "created_at": f"gte.{since}",
        "select": "id,title,scheduled_for,created_at",
        "order": "created_at.desc",
    }) or []
    return rows


def fetch_reminders_for_group(group_id, since_minutes=5):
    hhid = fetch_household_for_group(group_id)
    if not hhid:
        return []
    since = (datetime.now(timezone.utc) - timedelta(minutes=since_minutes)).isoformat()
    rows = sb_get("reminder_queue", {
        "household_id": f"eq.{hhid}",
        "created_at": f"gte.{since}",
        "select": "id,message_text,send_at,sent,sent_at,created_at",
        "order": "created_at.desc",
    }) or []
    return rows


def fetch_bot_replies(group_id, since_seconds=10):
    since = (datetime.now(timezone.utc) - timedelta(seconds=since_seconds)).isoformat()
    rows = sb_get("whatsapp_messages", {
        "group_id": f"eq.{log_lookup_id(group_id)}",
        "sender_phone": f"eq.{BOT_PHONE}",
        "created_at": f"gte.{since}",
        "select": "message_text,created_at,classification",
        "order": "created_at.desc",
    }) or []
    return rows


def israel_time_hhmm(iso_str):
    d = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    il = d.astimezone(timezone(timedelta(hours=3)))  # IDT approximation, fine for HH:MM assertions
    return il.strftime("%H:%M")


def minutes_ago_iso(n):
    return (datetime.now(timezone.utc) - timedelta(minutes=n)).isoformat()


def insert_reminder_direct(hhid, group_id, text, send_at_iso, sent=False, sent_at_iso=None):
    reminder_id = str(uuid.uuid4())
    row = {
        "id": reminder_id,
        "household_id": hhid,
        "group_id": group_id,
        "message_text": text,
        "send_at": send_at_iso,
        "sent": sent,
        "reminder_type": "user",
    }
    if sent_at_iso:
        row["sent_at"] = sent_at_iso
    sb_post("reminder_queue", row)
    return reminder_id


def fetch_reminder_by_id(reminder_id):
    rows = sb_get("reminder_queue", {
        "id": f"eq.{reminder_id}",
        "select": "id,message_text,send_at,sent,sent_at",
        "limit": "1",
    }) or []
    return rows[0] if rows else None


@unittest.skip("TestCorrectBotV2 requires deployed Edge Function — un-skip in Task 7")
class TestCorrectBotV2(unittest.TestCase):
    """Group-path correction with Sonnet-ACTIONS (update/remove/clarify).

    Tests 1-7 use real Sonnet against the live Edge Function with seeded
    events/reminders under each TEST_GROUP_N's auto-created household.
    Test 8 requires CORRECTION_SONNET_MOCK=malformed set on the function.
    """

    def test_01_time_only_event_update_preserves_id(self):
        group_id = TEST_GROUP_2
        send_group_message(group_id, TEST_PHONE_1, "בדיקת שיניים ביום רביעי ב-14:00")
        time.sleep(4)
        events_before = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_before) == 1, f"seed failed: {events_before}"
        original_id = events_before[0]["id"]

        send_group_message(group_id, TEST_PHONE_1, "תתקני ל-15:00")
        time.sleep(5)

        events_after = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_after) == 1, f"Expected no dup, got {len(events_after)}"
        assert events_after[0]["id"] == original_id, "id must be preserved"
        assert "15:00" in israel_time_hhmm(events_after[0]["scheduled_for"])

    def test_02_date_only_update_preserves_id(self):
        group_id = TEST_GROUP_5
        send_group_message(group_id, TEST_PHONE_1, "ארוחה עם סבתא בחמישי ב-19:00")
        time.sleep(4)
        events_before = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_before) == 1
        original_id = events_before[0]["id"]

        send_group_message(group_id, TEST_PHONE_1, "לא חמישי, שבת")
        time.sleep(5)
        events_after = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_after) == 1
        assert events_after[0]["id"] == original_id
        sf = datetime.fromisoformat(events_after[0]["scheduled_for"].replace("Z", "+00:00"))
        assert sf.weekday() in (5, 6), f"Expected Sat, got weekday {sf.weekday()}"

    def test_03_reminder_time_shift_preserves_id_and_sent_false(self):
        group_id = TEST_GROUP_3
        send_group_message(group_id, TEST_PHONE_1, "תזכירי לי מחר ב-8 לקחת ויטמין")
        time.sleep(4)
        reminders = fetch_reminders_for_group(group_id, since_minutes=2)
        assert len(reminders) == 1
        original_id = reminders[0]["id"]

        send_group_message(group_id, TEST_PHONE_1, "תעבירי ל-9")
        time.sleep(5)

        reminders_after = fetch_reminders_for_group(group_id, since_minutes=2)
        assert len(reminders_after) == 1
        assert reminders_after[0]["id"] == original_id
        assert reminders_after[0]["sent"] == False
        assert "09:00" in israel_time_hhmm(reminders_after[0]["send_at"])

    def test_04_remove_event_hard_delete(self):
        group_id = TEST_GROUP_6
        send_group_message(group_id, TEST_PHONE_1, "ארוחת ערב ב-19:00 מחר")
        time.sleep(4)
        events_before = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_before) == 1

        send_group_message(group_id, TEST_PHONE_1, "תבטלי את זה")
        time.sleep(5)
        events_after = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_after) == 0, f"Expected deletion, got {events_after}"

        replies = fetch_bot_replies(group_id, since_seconds=10)
        assert any(
            ("בוטלה" in (r.get("message_text") or "")) or ("תיקנתי" in (r.get("message_text") or ""))
            for r in replies
        )

    def test_05_ambiguous_multi_match_clarifies(self):
        group_id = TEST_GROUP_4
        send_group_message(group_id, TEST_PHONE_1, "בדיקת דירה ביום שישי ב-08:00")
        time.sleep(3)
        send_group_message(group_id, TEST_PHONE_1, "בדיקת דירה ביום שבת ב-10:00")
        time.sleep(3)

        send_group_message(group_id, TEST_PHONE_1, "תתקני את בדיקת הדירה ל-11:00")
        time.sleep(5)

        events = fetch_events_for_group(group_id, since_minutes=3)
        assert len(events) == 2, f"No DB change expected, got {len(events)}"
        replies = fetch_bot_replies(group_id, since_seconds=10)
        assert any(
            ("איזה" in (r.get("message_text") or "")) or ("איזו" in (r.get("message_text") or ""))
            for r in replies
        )

    def test_06_no_event_exists_debug_token_leak(self):
        group_id = TEST_GROUP_7
        send_group_message(group_id, TEST_PHONE_1, "תור לרופא מחר ב-10:00")
        time.sleep(4)
        send_group_message(group_id, TEST_PHONE_1, "תתקני ל-11:00")
        time.sleep(5)

        replies = fetch_bot_replies(group_id, since_seconds=10)
        for r in replies:
            body = r.get("message_text") or ""
            assert "Event-exists:" not in body, f"Debug token leaked: {body}"
            assert "Reminder-exists:" not in body
            assert "old_title" not in body

    def test_07_fired_reminder_noop(self):
        """Reminder already fired is invisible to the candidate gatherer."""
        group_id = TEST_GROUP_8
        send_group_message(group_id, TEST_PHONE_1, "היי")  # ensures household exists
        time.sleep(3)
        hhid = fetch_household_for_group(group_id)
        assert hhid, "household setup failed"
        reminder_id = insert_reminder_direct(
            hhid, group_id, text="לקחת תרופה",
            send_at_iso=minutes_ago_iso(5),
            sent=True, sent_at_iso=minutes_ago_iso(5),
        )
        send_group_message(group_id, TEST_PHONE_1, "תעבירי את תזכורת התרופה ל-9")
        time.sleep(5)
        replies = fetch_bot_replies(group_id, since_seconds=10)
        assert any(
            ("לא מצאתי" in (r.get("message_text") or "")) or ("כבר נשלחה" in (r.get("message_text") or ""))
            for r in replies
        )
        fresh = fetch_reminder_by_id(reminder_id)
        assert fresh and fresh["sent"] == True

    def test_08_malformed_sonnet_falls_back_to_clarify(self):
        """Mocked Sonnet JSON parse failure → clarify reply, no DB change.

        Requires CORRECTION_SONNET_MOCK=malformed env var on Edge Function
        (set temporarily during Task 7 smoke). Without the mock this test
        will fail because real Sonnet returns valid JSON — skip it in that
        case."""
        if os.environ.get("RUN_MALFORMED_SONNET_TEST") != "1":
            self.skipTest("Set RUN_MALFORMED_SONNET_TEST=1 + CORRECTION_SONNET_MOCK=malformed on EF")
        group_id = TEST_GROUP_1
        send_group_message(group_id, TEST_PHONE_1, "ארוחת צהריים מחר ב-13:00")
        time.sleep(4)
        events_before = fetch_events_for_group(group_id, since_minutes=2)
        assert len(events_before) == 1
        original_id = events_before[0]["id"]

        send_group_message(group_id, TEST_PHONE_1, "תתקני ל-14:00")
        time.sleep(5)
        events_after = fetch_events_for_group(group_id, since_minutes=2)
        # No DB change — clarify path taken.
        assert len(events_after) == 1
        assert events_after[0]["id"] == original_id
        assert events_after[0]["scheduled_for"] == events_before[0]["scheduled_for"], \
            "scheduled_for must be unchanged on clarify fallback"
