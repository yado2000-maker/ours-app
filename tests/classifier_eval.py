"""
Classifier Evaluation Runner — tests Haiku intent classifier against 120+ Hebrew messages.

Run: python tests/classifier_eval.py
Requires: ANTHROPIC_API_KEY environment variable (or .env file in project root)

Output: confusion matrix, per-intent accuracy, misclassifications, pass/fail verdict.
Results saved to tests/classifier-results.json.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

# Fix Windows Hebrew encoding + force unbuffered output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Force unbuffered print
_orig_print = print
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    _orig_print(*args, **kwargs)

# Load .env if present
env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

try:
    import httpx
except ImportError:
    print("Installing httpx...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "httpx", "-q"])
    import httpx


# ─── Configuration ───

HAIKU_MODEL = "claude-haiku-4-5-20251001"
BATCH_SIZE = 5       # Send 5 requests per minute (matches rate limit exactly)
BATCH_PAUSE = 65.0   # Wait 65s between batches (full minute + 5s safety margin)
MAX_RETRIES = 3
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
RESULTS_FILE = Path(__file__).parent / "classifier-results.json"


# ─── Mock Household Context ───

MOCK_CONTEXT = {
    "members": ["אמא", "אבא", "נועה", "יונתן"],
    "openTasks": [
        {"id": "t1a2", "title": "לשטוף כלים", "assigned_to": "אבא"},
        {"id": "t3b4", "title": "לקבוע תור לרופא שיניים", "assigned_to": None},
        {"id": "t5c6", "title": "לסדר את הארון", "assigned_to": "נועה"},
        {"id": "t7d8", "title": "לקנות מתנה לסבתא", "assigned_to": "אמא"},
    ],
    "openShopping": [
        {"id": "s1a2", "name": "חלב", "qty": "2"},
        {"id": "s3b4", "name": "ביצים", "qty": "1"},
        {"id": "s5c6", "name": "לחם", "qty": None},
        {"id": "s7d8", "name": "אבקת כביסה", "qty": "1"},
    ],
}


# ─── Test Case Class ───


class TestCase:
    def __init__(self, input_text: str, sender: str, expected_intent: str, notes: str = ""):
        self.input = input_text
        self.sender = sender
        self.expected_intent = expected_intent
        self.notes = notes


# fmt: off
IGNORE_CASES = [
    TestCase("בוקר טוב!", "אמא", "ignore", "Morning greeting"),
    TestCase("לילה טוב חמודים", "אבא", "ignore", "Goodnight"),
    TestCase("😂😂😂", "נועה", "ignore", "Emoji-only"),
    TestCase("👍", "אבא", "ignore", "Thumbs up reaction"),
    TestCase("❤️", "אמא", "ignore", "Heart emoji"),
    TestCase("אמן", "אמא", "ignore", "Religious expression"),
    TestCase("בהצלחה!", "אבא", "ignore", "Good luck"),
    TestCase("סבבה", "נועה", "ignore", "Slang ack (no context)"),
    TestCase("אחלה", "יונתן", "ignore", "Slang praise"),
    TestCase("הגענו בשלום", "אמא", "ignore", "Arrived safely"),
    TestCase("ראיתם את התוכנית אתמול? מטורף", "אבא", "ignore", "TV discussion"),
    TestCase("חחח זה היה מצחיק", "נועה", "ignore", "Laughing"),
    TestCase("יאללה ביי", "יונתן", "ignore", "Goodbye slang"),
    TestCase("שבת שלום", "אמא", "ignore", "Shabbat greeting"),
    TestCase("חג שמח לכולם!", "אבא", "ignore", "Holiday greeting"),
    TestCase("תודה רבה על הכל", "נועה", "ignore", "General thanks"),
    TestCase("וואי כמה חם היום", "אמא", "ignore", "Weather complaint"),
    TestCase("מי ראה את המפתחות שלי?", "אבא", "ignore", "Lost keys — immediate, not task"),
    TestCase("אוקי", "יונתן", "ignore", "Simple ack"),
    TestCase("נו מה קורה", "נועה", "ignore", "What's up"),
    TestCase("אממ ככה ככה היום היה קשה", "אמא", "ignore", "Voice-to-text filler + social"),
    TestCase("🎉🎂🎁 יום הולדת שמח!", "אבא", "ignore", "Birthday wish"),
    TestCase("Forwarded: check out this article about...", "נועה", "ignore", "Forwarded content"),
    TestCase("LOL that's hilarious", "יונתן", "ignore", "English social"),
    TestCase("יא אלוהים איזה גול", "אבא", "ignore", "Sports reaction"),
]

ADD_SHOPPING_CASES = [
    TestCase("חלב", "אמא", "add_shopping", "Bare noun"),
    TestCase("3 חלב", "אבא", "add_shopping", "Quantity + noun"),
    TestCase("עוד חלב", "נועה", "add_shopping", "More + noun"),
    TestCase("חלב, ביצים, לחם", "אמא", "add_shopping", "Comma-separated"),
    TestCase("צריך חלב וביצים", "אבא", "add_shopping", "Need + items"),
    TestCase("צריך לקנות גבינה צהובה ויוגורט", "אמא", "add_shopping", "Need to buy"),
    TestCase("אפשר להוסיף קוטג' לרשימה?", "נועה", "add_shopping", "Polite add request"),
    TestCase("נגמר לנו אורז", "אמא", "add_shopping", "Ran out of"),
    TestCase("need milk", "יונתן", "add_shopping", "English shopping"),
    TestCase("צריך milk ו-bread", "יונתן", "add_shopping", "Mixed Hebrew/English"),
    TestCase("2 קילו עגבניות", "אמא", "add_shopping", "Quantity with unit"),
    TestCase("אין לנו סבון כלים", "אבא", "add_shopping", "We don't have"),
    TestCase("🛒 שמנת, קצפת, קקאו", "אמא", "add_shopping", "Cart emoji + items"),
    TestCase("תוסיפו נייר טואלט", "אבא", "add_shopping", "Imperative add"),
    TestCase("פירות ירקות", "אמא", "add_shopping", "Two bare nouns"),
    TestCase("חסר שמן זית ומלח", "אמא", "add_shopping", "Missing"),
    TestCase("אנחנו צריכים דבש לראש השנה", "אמא", "add_shopping", "We need honey"),
    TestCase("pasta and cheese", "יונתן", "add_shopping", "Full English"),
    TestCase("שוקולד!! הילדים רוצים", "נועה", "add_shopping", "Emphatic + reason"),
    TestCase("חומוס טחינה פיתות", "אבא", "add_shopping", "Three items no separators"),
]

ADD_TASK_CASES = [
    TestCase("צריך לנקות את הבית", "אמא", "add_task", "Explicit task"),
    TestCase("מישהו יכול לשטוף את הרכב?", "אבא", "add_task", "Question as task"),
    TestCase("נועה חוג 5", "אמא", "add_task", "Implicit [person] [activity] [time]"),
    TestCase("יונתן צריך הסעה לאימון", "אבא", "add_task", "Person needs ride"),
    TestCase("אבא תוציא את הזבל", "אמא", "add_task", "Direct assignment"),
    TestCase("צריך לתקן את הברז במטבח", "אבא", "add_task", "Maintenance"),
    TestCase("מישהו צריך לאסוף את הילדים מהגן ב4", "אמא", "add_task", "Pickup with time"),
    TestCase("חייבים לשלם חשבון חשמל", "אבא", "add_task", "Must pay bill"),
    TestCase("אל תשכחו לתת לכלב אוכל", "נועה", "add_task", "Don't forget"),
    TestCase("הארון בחדר של נועה נשבר, צריך לתקן", "אמא", "add_task", "Context + task"),
    TestCase("צריך לקבוע תור לווטרינר", "אבא", "add_task", "Vet appointment"),
    TestCase("לגהץ את הבגדים של יונתן לחתונה", "אמא", "add_task", "Iron clothes"),
    TestCase("מישהו יטען את הטאבלט של נועה", "אבא", "add_task", "Charge tablet"),
    TestCase("need to call the plumber", "אבא", "add_task", "English task"),
    TestCase("יונתן תנקה את החדר שלך", "אמא", "add_task", "Direct command to child"),
    TestCase("אממ צריך לסדר את המרפסת כי ביום שישי באים אורחים", "אמא", "add_task", "VTT + reason"),
    TestCase("לארגן את ארון התרופות", "אבא", "add_task", "Bare infinitive"),
    TestCase("להכין ארוחות צהריים לילדים", "אמא", "add_task", "Lunch prep"),
    TestCase("אבא - הילדים צריכים להגיש טופס לבית ספר", "אמא", "add_task", "Addressed with dash"),
    TestCase("אי אפשר לשכוח לחדש ביטוח רכב", "אבא", "add_task", "Cant forget — urgent"),
]

ADD_EVENT_CASES = [
    TestCase("יום שלישי ארוחת ערב אצל סבתא", "אמא", "add_event", "Hebrew day + event"),
    TestCase("מחר ב10 יש אסיפת הורים", "אבא", "add_event", "Tomorrow + time"),
    TestCase("רופא שיניים ליונתן ביום חמישי בשעה 3", "אמא", "add_event", "Appointment full date"),
    TestCase("יש meeting ב-3", "אבא", "add_event", "Mixed Hebrew/English"),
    TestCase("חתונה של דודה מירי ביום שישי", "אמא", "add_event", "Family event Friday"),
    TestCase("שיעור פסנתר של נועה ביום ראשון 16:00", "אמא", "add_event", "Lesson + person + time"),
    TestCase("אחרי הצהריים יש אימון כדורגל ליונתן", "אבא", "add_event", "Vague time"),
    TestCase("ראש השנה אצל ההורים", "אמא", "add_event", "Holiday event"),
    TestCase("zoom call עם הסבתא ביום רביעי ב7 בערב", "נועה", "add_event", "Mixed lang + evening"),
    TestCase("הזמנו שולחן למסעדה ליום שבת ב-8", "אבא", "add_event", "Reservation"),
    TestCase("Birthday party for Noa next Sunday at 4", "אמא", "add_event", "English event"),
    TestCase("הפגישה עם המורה נדחתה ליום שני", "אמא", "add_event", "Rescheduled meeting"),
    TestCase("לפני שבת צריך להגיע לסבא", "אמא", "add_event", "Before Shabbat"),
    TestCase("הצגה של נועה בבית ספר ביום רביעי ב11", "אמא", "add_event", "School performance"),
    TestCase("דוקטור אצל דר גולדברג ב14 ביום חמישי", "אבא", "add_event", "Doctor appointment"),
]

COMPLETE_TASK_CASES = [
    TestCase("שטפתי את הכלים", "אבא", "complete_task", "Past tense of open task"),
    TestCase("הכלים מוכנים", "אבא", "complete_task", "Implicit — dishes are done"),
    TestCase("סיימתי עם הארון", "נועה", "complete_task", "Finished closet"),
    TestCase("קבעתי תור לרופא שיניים", "אמא", "complete_task", "Completed scheduling"),
    TestCase("done with the dishes", "אבא", "complete_task", "English completion"),
    TestCase("עשיתי את זה ✅", "נועה", "complete_task", "Generic did it + checkmark"),
    TestCase("המתנה לסבתא מוכנה", "אמא", "complete_task", "Gift is ready"),
    TestCase("בוצע", "אבא", "complete_task", "Generic done"),
    TestCase("טיפלתי בזה", "אמא", "complete_task", "Handled it"),
    TestCase("סידרתי את הארון של נועה", "נועה", "complete_task", "Explicit match"),
]

COMPLETE_SHOPPING_CASES = [
    TestCase("קניתי חלב", "אמא", "complete_shopping", "Bought milk"),
    TestCase("יש חלב", "אבא", "complete_shopping", "Have milk"),
    TestCase("לקחתי ביצים ולחם", "אמא", "complete_shopping", "Took eggs and bread"),
    TestCase("הלחם בבית", "אבא", "complete_shopping", "Bread is home"),
    TestCase("got the eggs", "יונתן", "complete_shopping", "English confirmation"),
    TestCase("מצאתי אבקת כביסה במבצע ולקחתי", "אמא", "complete_shopping", "Found on sale"),
    TestCase("✅ חלב ביצים לחם", "אמא", "complete_shopping", "Checkmark + items"),
    TestCase("אני בסופר, לקחתי את הכל", "אבא", "complete_shopping", "At store got everything"),
    TestCase("הביצים אצלי", "אמא", "complete_shopping", "Eggs are with me"),
    TestCase("חלב וביצים ✓", "אבא", "complete_shopping", "Items with checkmark"),
]

QUESTION_CASES = [
    TestCase("מי אוסף היום?", "אמא", "question", "Whos picking up?"),
    TestCase("מה צריך מהסופר?", "אבא", "question", "Shopping list query"),
    TestCase("מה נשאר לעשות?", "נועה", "question", "Open tasks query"),
    TestCase("מתי הרופא של יונתן?", "אמא", "question", "Event query"),
    TestCase("מישהו יודע מה יש היום?", "אבא", "question", "Todays schedule"),
    TestCase("what's on the list?", "יונתן", "question", "English query"),
    TestCase("כמה משימות פתוחות יש?", "נועה", "question", "Task count"),
    TestCase("מה התוכניות למחר?", "אמא", "question", "Tomorrows plans"),
    TestCase("יש משהו דחוף?", "אבא", "question", "Urgency check"),
    TestCase("מי אמור לעשות את הכביסה?", "נועה", "question", "Task assignment query"),
]

CLAIM_TASK_CASES = [
    TestCase("אני אשטוף כלים", "אבא", "claim_task", "Ill wash dishes"),
    TestCase("אני לוקחת את התור לרופא", "אמא", "claim_task", "Feminine Ill take"),
    TestCase("אני אעשה את זה", "נועה", "claim_task", "Generic Ill do it"),
    TestCase("אני יכול לטפל במתנה", "אבא", "claim_task", "I can handle gift"),
    TestCase("I'll handle the dentist appointment", "אמא", "claim_task", "English claim"),
]

INFO_REQUEST_CASES = [
    TestCase("מה הסיסמא של הוויי פיי?", "נועה", "info_request", "WiFi password"),
    TestCase("שלח לי את הקוד", "יונתן", "info_request", "Send me the code"),
    TestCase("כמה עולה חוג כדורגל?", "אבא", "info_request", "Cost question"),
    TestCase("מה מספר הטלפון של הרופא?", "אמא", "info_request", "Phone number"),
    TestCase("where is the remote control?", "יונתן", "info_request", "English info request"),
]
# fmt: on

ALL_CASES = (
    IGNORE_CASES
    + ADD_SHOPPING_CASES
    + ADD_TASK_CASES
    + ADD_EVENT_CASES
    + COMPLETE_TASK_CASES
    + COMPLETE_SHOPPING_CASES
    + QUESTION_CASES
    + CLAIM_TASK_CASES
    + INFO_REQUEST_CASES
)


# ─── Classifier Prompt (mirrors haiku-classifier.ts) ───


def build_classifier_prompt() -> str:
    import datetime

    today = datetime.date.today()
    today_str = today.isoformat()
    hebrew_days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]
    # Python weekday: 0=Monday..6=Sunday -> Hebrew: 0=Sunday
    hebrew_dow_idx = (today.weekday() + 1) % 7
    day_name = hebrew_days[hebrew_dow_idx]

    upcoming = []
    for i in range(7):
        d = today + datetime.timedelta(days=i)
        heb_idx = (d.weekday() + 1) % 7
        label = f"{hebrew_days[heb_idx]} = {d.isoformat()}"
        if i == 0:
            label += " (today)"
        upcoming.append(label)

    tasks_str = "\n".join(
        f"* {t['title']}{' -> ' + t['assigned_to'] if t['assigned_to'] else ''} (id:{t['id']})"
        for t in MOCK_CONTEXT["openTasks"]
    ) or "(none)"

    shopping_str = "\n".join(
        f"* {s['name']}{' x' + s['qty'] if s['qty'] else ''} (id:{s['id']})"
        for s in MOCK_CONTEXT["openShopping"]
    ) or "(empty)"

    members_str = ", ".join(MOCK_CONTEXT["members"])
    upcoming_str = ", ".join(upcoming)

    return f"""You are a Hebrew family WhatsApp message classifier. Classify each message into exactly ONE intent.

INTENTS:
- ignore: Social noise (greetings, reactions, emojis, jokes, chatter, forwarded messages, status updates). ~80% of messages.
- add_shopping: Adding item(s) to shopping list. Bare nouns, "צריך X", "נגמר X", "אין X".
- add_task: Creating a household chore/to-do. "צריך ל...", "[person] [activity] [time]", maintenance requests.
- add_event: Scheduling a specific date/time event. Appointments, classes, dinners, meetings.
- complete_task: Marking an existing task as done. Past tense of open task, "סיימתי", "בוצע".
- complete_shopping: Confirming purchase of a list item. "קניתי", "יש", "לקחתי".
- question: Asking about household state (tasks, schedule, list). "מה צריך?", "מי אוסף?", "מה יש היום?".
- claim_task: Self-assigning an existing open task. "אני אעשה", "אני לוקח/ת", "אני יכול".
- info_request: Asking for information that is NOT a household task. Passwords, phone numbers, prices, codes.

MEMBERS: {members_str}
TODAY: {today_str} ({day_name})
UPCOMING: {upcoming_str}

OPEN TASKS:
{tasks_str}

SHOPPING LIST:
{shopping_str}

HEBREW PATTERNS:
- Bare noun ("חלב") = add_shopping
- "[person] [activity] [time]" ("נועה חוג 5") = add_task
- "מי [verb]?" = question (not add_task)
- "אני [verb]" matching an open task = claim_task
- Past tense matching open task ("שטפתי כלים") = complete_task
- "קניתי X" / "יש X" matching shopping item = complete_shopping
- Greetings, emojis, reactions, "סבבה", "אמן", "בהצלחה" = ignore
- "מה הסיסמא?", "שלח קוד" = info_request (NOT add_task)
- Hebrew time: "ב5" = 17:00, "בצהריים" = ~12:00, "אחרי הגן" = ~16:00, "לפני שבת" = Friday PM

HEBREW DAYS: ראשון=Sunday, שני=Monday, שלישי=Tuesday, רביעי=Wednesday, חמישי=Thursday, שישי=Friday, שבת=Saturday

EXAMPLES:
[אמא]: "בוקר טוב!" -> {{"intent":"ignore","confidence":0.99,"entities":{{"raw_text":"בוקר טוב!"}}}}
[אבא]: "חלב" -> {{"intent":"add_shopping","confidence":0.95,"entities":{{"items":[{{"name":"חלב"}}],"raw_text":"חלב"}}}}
[אמא]: "נועה חוג 5" -> {{"intent":"add_task","confidence":0.90,"entities":{{"person":"נועה","title":"חוג","time_raw":"5","raw_text":"נועה חוג 5"}}}}
[אבא]: "שטפתי את הכלים" -> {{"intent":"complete_task","confidence":0.95,"entities":{{"task_id":"t1a2","raw_text":"שטפתי את הכלים"}}}}
[אמא]: "מה צריך מהסופר?" -> {{"intent":"question","confidence":0.95,"entities":{{"raw_text":"מה צריך מהסופר?"}}}}
[נועה]: "אני אסדר את הארון" -> {{"intent":"claim_task","confidence":0.90,"entities":{{"person":"נועה","task_id":"t5c6","raw_text":"אני אסדר את הארון"}}}}
[אמא]: "יום שלישי ארוחת ערב אצל סבתא" -> {{"intent":"add_event","confidence":0.92,"entities":{{"title":"ארוחת ערב אצל סבתא","time_raw":"יום שלישי","raw_text":"יום שלישי ארוחת ערב אצל סבתא"}}}}
[יונתן]: "מה הסיסמא של הוויי פיי?" -> {{"intent":"info_request","confidence":0.95,"entities":{{"raw_text":"מה הסיסמא של הוויי פיי?"}}}}
[אמא]: "קניתי חלב וביצים" -> {{"intent":"complete_shopping","confidence":0.95,"entities":{{"item_id":"s1a2","raw_text":"קניתי חלב וביצים"}}}}

RULES:
- Respond with ONLY a JSON object. No other text, no markdown.
- Always include raw_text in entities.
- For complete_task/complete_shopping/claim_task: match against open tasks/shopping IDs above.
- For add_event: include time_raw (Hebrew expression) and time_iso (ISO 8601 with +03:00) if resolvable.
- For add_shopping: extract individual items into the items array.
- Confidence: 0.95+ for clear cases, 0.70-0.90 for moderate, 0.50-0.69 for ambiguous.
- When unsure between action and ignore, prefer ignore (false silence > false action)."""


# ─── API call ───


async def classify_one(
    client: httpx.AsyncClient, tc: TestCase, system_prompt: str
) -> dict:
    t0 = time.time()
    for attempt in range(MAX_RETRIES):
        try:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": HAIKU_MODEL,
                    "max_tokens": 512,
                    "system": system_prompt,
                    "messages": [
                        {"role": "user", "content": f"[{tc.sender}]: {tc.input}"}
                    ],
                },
                timeout=30.0,
            )
            latency = (time.time() - t0) * 1000

            if resp.status_code == 429:
                wait = 15 * (attempt + 1)
                print(f"  Rate limited, waiting {wait}s (attempt {attempt+1}/{MAX_RETRIES})...")
                await asyncio.sleep(wait)
                continue

            if resp.status_code != 200:
                print(f"  API error {resp.status_code}: {resp.text[:200]}")
                return {
                    "input": tc.input, "sender": tc.sender,
                    "expected": tc.expected_intent, "actual": "ignore",
                    "confidence": 0.0, "correct": tc.expected_intent == "ignore",
                    "latency_ms": latency, "notes": tc.notes,
                    "error": f"HTTP {resp.status_code}",
                }

            data = resp.json()
            raw = data.get("content", [{}])[0].get("text", "{}")
            raw = raw.replace("```json", "").replace("```", "").strip()

            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                print(f"  JSON parse error: {raw[:100]}")
                parsed = {"intent": "ignore", "confidence": 0.0}

            actual = parsed.get("intent", "ignore")
            confidence = parsed.get("confidence", 0.5)

            return {
                "input": tc.input, "sender": tc.sender,
                "expected": tc.expected_intent, "actual": actual,
                "confidence": confidence,
                "correct": actual == tc.expected_intent,
                "latency_ms": latency, "notes": tc.notes,
                "entities": parsed.get("entities", {}),
            }
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(10)
                continue
            return {
                "input": tc.input, "sender": tc.sender,
                "expected": tc.expected_intent, "actual": "ignore",
                "confidence": 0.0, "correct": tc.expected_intent == "ignore",
                "latency_ms": (time.time() - t0) * 1000, "notes": tc.notes,
                "error": str(e),
            }
    # All retries exhausted
    return {
        "input": tc.input, "sender": tc.sender,
        "expected": tc.expected_intent, "actual": "ignore",
        "confidence": 0.0, "correct": tc.expected_intent == "ignore",
        "latency_ms": (time.time() - t0) * 1000, "notes": tc.notes,
        "error": "max retries exhausted",
    }


# ─── Concurrent execution ───


async def run_evaluation():
    if not API_KEY:
        print("ERROR: ANTHROPIC_API_KEY environment variable is required")
        print("Set it via: export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    system_prompt = build_classifier_prompt()

    print()
    print("+" + "=" * 46 + "+")
    print("|  Haiku Intent Classifier - Test Suite         |")
    print(f"|  Cases: {len(ALL_CASES):<5} | Batch: {BATCH_SIZE}/min          |")
    print(f"|  Date:  {time.strftime('%Y-%m-%d')}                        |")
    print("+" + "=" * 46 + "+")
    print()

    # Show distribution
    from collections import Counter
    dist = Counter(tc.expected_intent for tc in ALL_CASES)
    print("Distribution:", dict(sorted(dist.items())))
    total_batches = (len(ALL_CASES) + BATCH_SIZE - 1) // BATCH_SIZE
    est_minutes = total_batches * (BATCH_PAUSE / 60)
    print(f"\nRunning {len(ALL_CASES)} cases in batches of {BATCH_SIZE} ({total_batches} batches, ~{est_minutes:.0f} min)...\n")

    # Batch processing: fire 5 requests concurrently, wait 65s, repeat
    results = []
    async with httpx.AsyncClient() as client:
        for batch_idx in range(total_batches):
            batch_start = batch_idx * BATCH_SIZE
            batch_end = min(batch_start + BATCH_SIZE, len(ALL_CASES))
            batch_cases = ALL_CASES[batch_start:batch_end]

            # Fire all requests in this batch concurrently
            batch_tasks = [
                classify_one(client, tc, system_prompt)
                for tc in batch_cases
            ]
            batch_results = await asyncio.gather(*batch_tasks)
            results.extend(batch_results)

            # Print progress
            completed = len(results)
            pct = round(completed / len(ALL_CASES) * 100)
            correct_so_far = sum(1 for r in results if r["correct"])
            errors = sum(1 for r in batch_results if r.get("error"))

            # Show batch summary
            batch_ok = sum(1 for r in batch_results if r["correct"])
            batch_total = len(batch_results)
            print(f"  Batch {batch_idx+1}/{total_batches}: {batch_ok}/{batch_total} correct | "
                  f"Overall: {correct_so_far}/{completed} ({pct}%)"
                  f"{f' | {errors} errors' if errors else ''}")

            # Wait for rate limit window to reset before next batch
            if batch_end < len(ALL_CASES):
                remaining_batches = total_batches - batch_idx - 1
                print(f"    Waiting {BATCH_PAUSE:.0f}s for rate limit reset... ({remaining_batches} batches left)")
                await asyncio.sleep(BATCH_PAUSE)

    # ─── Compute metrics ───

    correct = sum(1 for r in results if r["correct"])
    accuracy = correct / len(results)
    avg_latency = sum(r["latency_ms"] for r in results) / len(results)
    avg_confidence = sum(r["confidence"] for r in results) / len(results)

    # Per-intent
    intents = sorted(set(tc.expected_intent for tc in ALL_CASES))
    per_intent = {}
    for intent in intents:
        intent_results = [r for r in results if r["expected"] == intent]
        intent_correct = sum(1 for r in intent_results if r["correct"])
        per_intent[intent] = {
            "total": len(intent_results),
            "correct": intent_correct,
            "accuracy": intent_correct / len(intent_results) if intent_results else 0,
        }

    # Confusion matrix
    all_intents = sorted(set(intents) | set(r["actual"] for r in results))
    confusion = {e: {a: 0 for a in all_intents} for e in all_intents}
    for r in results:
        exp, act = r["expected"], r["actual"]
        if exp not in confusion:
            confusion[exp] = {a: 0 for a in all_intents}
        confusion[exp][act] = confusion[exp].get(act, 0) + 1

    # Misclassifications
    misclass = [
        {
            "input": r["input"],
            "sender": r["sender"],
            "expected": r["expected"],
            "actual": r["actual"],
            "confidence": r["confidence"],
            "notes": r.get("notes", ""),
        }
        for r in results
        if not r["correct"]
    ]

    # ─── Print results ───

    print()
    print("=" * 60)
    print("  RESULTS")
    print("=" * 60)
    print(f"  Overall Accuracy: {accuracy*100:.1f}% ({correct}/{len(results)})")
    print(f"  Avg Latency:      {avg_latency:.0f}ms")
    print(f"  Avg Confidence:   {avg_confidence*100:.1f}%")
    print()

    # Per-intent table
    print(f"  {'Intent':<20} {'Total':<7} {'Correct':<9} Accuracy")
    print(f"  {'-'*50}")
    for intent in intents:
        pi = per_intent[intent]
        acc = pi["accuracy"] * 100
        mark = "+" if acc >= 80 else "~" if acc >= 70 else "X"
        print(f"  {mark} {intent:<18} {pi['total']:<7} {pi['correct']:<9} {acc:.1f}%")

    # Confusion matrix
    if misclass:
        print(f"\n  CONFUSION MATRIX (rows=expected, cols=actual)")
        col_width = 12
        labels = [i[:10].ljust(col_width) for i in all_intents]
        print(f"  {'':18} {' '.join(labels)}")
        for exp in all_intents:
            row = [str(confusion[exp].get(act, 0)).ljust(col_width) for act in all_intents]
            print(f"  {exp:18} {' '.join(row)}")

    # Misclassifications
    if misclass:
        print(f"\n  MISCLASSIFICATIONS ({len(misclass)}):")
        print(f"  {'-'*50}")
        for m in misclass:
            print(f"  [{m['sender']}]: \"{m['input']}\"")
            print(f"    Expected: {m['expected']} -> Got: {m['actual']} (conf: {m['confidence']*100:.0f}%)")
            if m["notes"]:
                print(f"    Note: {m['notes']}")
            print()

    # Pass/fail
    print("=" * 60)
    passed = accuracy >= 0.85
    ignore_acc = per_intent.get("ignore", {}).get("accuracy", 0)
    ignore_pass = ignore_acc >= 0.9
    print(f"  Overall >=85%:  {'PASS' if passed else 'FAIL'} ({accuracy*100:.1f}%)")
    print(f"  Ignore >=90%:   {'PASS' if ignore_pass else 'FAIL'} ({ignore_acc*100:.1f}%)")
    print("=" * 60)
    print()

    # ─── Save results ───

    summary = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model": HAIKU_MODEL,
        "total_cases": len(results),
        "correct": correct,
        "accuracy": round(accuracy, 4),
        "per_intent": per_intent,
        "confusion_matrix": confusion,
        "avg_latency_ms": round(avg_latency, 1),
        "avg_confidence": round(avg_confidence, 4),
        "misclassifications": misclass,
    }

    try:
        RESULTS_FILE.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
        print(f"Results saved to {RESULTS_FILE}")
    except Exception as e:
        print(f"Could not save results: {e}")

    return accuracy


if __name__ == "__main__":
    accuracy = asyncio.run(run_evaluation())
    if accuracy < 0.85:
        print(f"\nFAILED: Accuracy {accuracy*100:.1f}% is below 85% threshold")
        sys.exit(1)
