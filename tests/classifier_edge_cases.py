"""
Hebrew edge-case classifier test — fires variations at live webhook.
Tests: wrong conjugation, slang, typos, minimal forms, declaratives.
"""
import json, time, sys, os, uuid, requests

WEBHOOK = "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whatsapp-webhook"
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://wzwwtghtnkapdwlgnrxr.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_KEY:
    from dotenv import load_dotenv
    load_dotenv()
    SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
TEST_PHONE = "972559999888"
TEST_GROUP = "972559999888_test_edge@g.us"

# ── Test cases: (message, expected_intent, note) ──
CASES = [
    # --- Tasks: conjugation errors (VERY common in spoken Hebrew) ---
    ("אני יסדר את החדר", "claim_task", "wrong conjugation: יסדר instead of אסדר"),
    ("אני יעשה את הכלים", "claim_task", "wrong conjugation: יעשה instead of אעשה"),
    ("אני ינקה את השירותים", "claim_task", "wrong conjugation: ינקה instead of אנקה"),

    # --- Tasks: informal/slang ---
    ("לעשות כלים", "add_task", "slang: לעשות כלים = wash dishes"),
    ("מדיח", "add_task", "single word: just the appliance name = unload dishwasher"),
    ("כביסה", "add_task", "single word: laundry"),
    ("לפנות מדיח", "add_task", "alternative verb: לפנות instead of לפרוק"),
    ("לתלות כביסה", "add_task", "specific chore: hang laundry"),
    ("יאללה מי מנקה היום", "question", "casual question about rotation/chores"),

    # --- Tasks: completion — past tense variations ---
    ("עשיתי כלים", "complete_task", "past tense: I did dishes"),
    ("ניקיתי", "complete_task", "minimal past tense: I cleaned (no object)"),
    ("גמרנו", "complete_task", "plural: we finished"),
    ("סגור", "complete_task", "slang: done/closed"),
    ("יאללה עשוי", "complete_task", "slang: yalla done"),
    ("סידרתי חדר", "complete_task", "past: I tidied room"),
    ("הכלים שטופים", "complete_task", "passive: dishes are washed"),

    # --- Shopping: brand names + conditions ---
    ("קוטג תנובה", "add_shopping", "brand name: cottage cheese Tnuva"),
    ("קולה זירו", "add_shopping", "brand + variant: Coke Zero"),
    ("ביסלי גריל", "add_shopping", "Israeli brand: Bissli grill flavor"),
    ("במבה", "add_shopping", "single word: Bamba (iconic snack)"),
    ("חלב תנובה 3%", "add_shopping", "brand + percentage"),
    ("שוקו", "add_shopping", "slang: chocolate milk"),
    ("2 קרטוני חלב", "add_shopping", "quantity + container: 2 cartons milk"),
    ("אם יש במבצע תביאו שניים", "add_shopping", "conditional shopping"),

    # --- Events: casual/declarative ---
    ("מחר בערב סבא וסבתא", "add_event", "casual: tomorrow evening grandparents"),
    ("ארוחת צהריים עם רונית", "add_event", "no time: lunch with Ronit"),
    ("יש לנו רופא ביום רביעי", "add_event", "declarative: we have a doctor on Wednesday"),
    ("השבוע חוג ריקוד", "add_event", "this week: dance class"),
    ("נסיעה לאילת בשישי", "add_event", "trip + day: Eilat on Friday"),

    # --- Reminders: informal ---
    ("תזכירי אותי לשלם ארנונה", "add_reminder", "reminder with אותי instead of לי"),
    ("אל תתני לי לשכוח לקנות מתנה", "add_reminder", "negative form: don't let me forget"),
    ("שלי תזכירי חשבון חשמל", "add_reminder", "name + reminder, no time"),

    # --- Questions: rotation/status ---
    ("מי בתור", "question", "minimal: whose turn"),
    ("תור מי היום", "question", "rotation: whose turn today"),
    ("מה נשאר ברשימה", "question", "shopping status"),
    ("מה עם המטלות", "question", "task status"),
    ("יש משהו ליומן", "question", "calendar check"),

    # --- Ignore: should NOT be classified as actionable ---
    ("אני בדרך", "ignore", "status update: on my way"),
    ("בסדר", "ignore", "acknowledgment: OK"),
    ("מגיעים בעוד 10 דקות", "ignore", "ETA: arriving in 10 min"),
    ("אהבתי את הארוחה", "ignore", "social: loved the meal"),
    ("מישהו ראה את השלט", "ignore", "general question to family, not bot"),
]


def send_test(text: str) -> dict:
    """Send a message to the webhook and fetch the classification."""
    msg_id = f"edge_{uuid.uuid4().hex[:8]}"
    payload = {"messages": [{
        "id": msg_id,
        "from": f"{TEST_PHONE}@s.whatsapp.net",
        "chat_id": TEST_GROUP,
        "from_name": "QA Tester",
        "type": "text",
        "text": {"body": text},
        "timestamp": int(time.time()),
    }]}
    try:
        r = requests.post(WEBHOOK, json=payload, timeout=30)
    except Exception as e:
        return {"error": str(e)}

    # Wait for classification to be written
    time.sleep(4)

    # Fetch classification
    url = f"{SUPABASE_URL}/rest/v1/whatsapp_messages?whatsapp_message_id=eq.{msg_id}&select=classification,classification_data&order=created_at.desc&limit=2"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        rows = resp.json()
        # Take the last row (the one with actual classification, not "received")
        for row in rows:
            if row.get("classification") not in ("received", None):
                return row
        # If only "received", return that
        return rows[0] if rows else {"error": "no rows"}
    except Exception as e:
        return {"error": str(e)}


def main():
    print(f"\n{'='*60}")
    print(f"  Hebrew Edge-Case Classifier Test")
    print(f"  {time.strftime('%Y-%m-%d %H:%M')}")
    print(f"  {len(CASES)} test cases")
    print(f"{'='*60}\n")

    results = {"pass": 0, "fail": 0, "error": 0}
    failures = []

    for i, (text, expected, note) in enumerate(CASES):
        result = send_test(text)
        classification = result.get("classification", "?")
        cd = result.get("classification_data") or {}
        actual_intent = cd.get("intent", "?") if isinstance(cd, dict) else "?"

        # Map classification to effective intent
        if classification in ("haiku_ignore", "sonnet_escalated_social"):
            effective = "ignore"
        elif classification in ("batch_actionable", "batch_pending"):
            effective = "add_shopping"
        elif classification == "explicit_undo":
            effective = "correct_bot"
        elif classification in ("haiku_actionable", "sonnet_escalated", "direct_address_reply"):
            effective = actual_intent
        elif classification == "haiku_reply_only":
            effective = actual_intent
        else:
            effective = actual_intent

        passed = effective == expected
        if passed:
            results["pass"] += 1
            mark = "[OK]"
        elif "error" in result:
            results["error"] += 1
            mark = "[ERR]"
        else:
            results["fail"] += 1
            mark = "[FAIL]"
            failures.append((text, expected, effective, classification, note))

        print(f"  {mark} \"{text}\"")
        if not passed:
            print(f"       Expected: {expected}, Got: {effective} (classification={classification})")
            print(f"       Note: {note}")

        # Rate limit: don't hammer the API
        if i < len(CASES) - 1:
            time.sleep(1.5)

    # Summary
    total = len(CASES)
    print(f"\n{'='*60}")
    print(f"  Results: {results['pass']}/{total} passed ({100*results['pass']/total:.0f}%)")
    print(f"  Failures: {results['fail']}, Errors: {results['error']}")

    if failures:
        print(f"\n  Failed cases ({len(failures)}):")
        print(f"  {'─'*56}")
        for text, expected, actual, classif, note in failures:
            print(f"  \"{text}\"")
            print(f"    Expected: {expected} → Got: {actual} ({classif})")
            print(f"    {note}")
    print(f"{'='*60}\n")

    # Cleanup test data
    print("  Cleaning up test data...")
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/whatsapp_messages?sender_phone=eq.{TEST_PHONE}",
        headers=HEADERS
    )
    print("  Done.\n")

    sys.exit(0 if results["fail"] == 0 else 1)


if __name__ == "__main__":
    main()
