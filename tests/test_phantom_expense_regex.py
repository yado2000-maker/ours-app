"""Bug 1 fix unit test (2026-05-07): the phantom-expense honesty guard regex
must REJECT capability-tour / greeting decorations that contain bare 💸 or
bare "הוצאה של", and ACCEPT real expense-save claims that combine the
expense lexicon with an actual money amount.

Run: python tests/test_phantom_expense_regex.py
"""
import re
import sys

PATTERN = re.compile(
    r'(רשמתי\s+הוצאה|הוצאה\s+של\s+\d|💸\s*\d+\s*(?:ש"?ח|₪|שקל)|\d+\s*(?:ש"?ח|₪|שקל)\s*💸|✅\s*\d+\s*(?:ש"?ח|₪|שקל))'
)


def should_match(s):
    """Real expense claim — guard SHOULD fire."""
    return bool(PATTERN.search(s))


CASES = [
    # ---- MUST NOT MATCH (capability/greeting decorations — Bug 1) ----
    ("היי איזבל! שמחה שהגעת 💛 אני שלי ואני יכולה לעזור עם:\n🛒 קניות\n⏰ תזכורות\n💸 הוצאות (דוגמה: שילמתי 200 על חשמל)\n📅 אירועים\nתנסי משהו!", False),
    ("אני יכולה לעזור עם:\n🛒 רשימות קניות (דוגמה: תוסיפי חלב)\n⏰ תזכורות (דוגמה: תזכירי לי מחר ב-9 להתקשר לאמא)\n✅ מטלות (דוגמה: תוסיפי מטלה לכבס)\n📅 אירועים (דוגמה: פגישה ביום שלישי ב-10)\n💸 הוצאות (דוגמה: שילמתי 200 על חשמל)", False),
    ("היי שירלי! שמחה שהגעת 💛 תזרקי לי 'קניתי חלב' או 'תזכירי לי בעוד שעה' או 💸 ואני אסדר", False),
    ("אני שלי. אני יודעת לטפל בקניות, תזכורות, מטלות, אירועים והוצאות 💸", False),
    # bare "הוצאה של" without a digit (e.g. inside a capability description)
    ("אני יודעת לרשום הוצאה של המשפחה — שלחי לי 'שילמתי X' ואני ארשום", False),
    # ---- MUST MATCH (real expense-save claims) ----
    ("💸 רשמתי הוצאה של 200 ש\"ח על דלק", True),
    ("רשמתי הוצאה של 350 ש\"ח על מכולת ✓", True),
    ("✅ 200 ש\"ח על דלק נרשמו", True),
    ("הוצאה של 500 על חשמל נרשמה ✓", True),
    ("רשמתי 💸 200 שקל על קפה", True),
    ("✅ 1500 ₪ על שכר דירה", True),
    ("רשמתי הוצאה - 200 שח", True),
    # ---- EDGE CASES ----
    # bare 💸 alone (no number) — must NOT match
    ("💸", False),
    # 💸 with currency only (no digit) — must NOT match
    ("הוצאה 💸 שקל", False),
]


def main():
    failures = []
    for i, (text, expected) in enumerate(CASES):
        actual = should_match(text)
        status = "OK" if actual == expected else "FAIL"
        if actual != expected:
            failures.append((i, text, expected, actual))
        print(f"[{status}] case#{i:02d} expected={expected} actual={actual}")
    print()
    if failures:
        print(f"FAILED: {len(failures)} / {len(CASES)}")
        # write Hebrew details to a UTF-8 file so the offender is visible
        with open("test_phantom_expense_regex_failures.txt", "w", encoding="utf-8") as f:
            for i, text, exp, act in failures:
                f.write(f"case#{i:02d} expected={exp} actual={act}\n  text: {text}\n\n")
        print("Hebrew details written to test_phantom_expense_regex_failures.txt")
        sys.exit(1)
    print(f"PASSED: {len(CASES)} / {len(CASES)}")


if __name__ == "__main__":
    main()
