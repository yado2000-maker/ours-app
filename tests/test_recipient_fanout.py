"""Parser shape contract for private DM reminders (2026-04-22).
Run: python -m unittest tests.test_recipient_fanout -v
Pure offline. Pins the block shapes the TS extractors must match.
"""
import json
import re
import unittest

REMINDER_RE = re.compile(r"<!--\s*REMINDER\s*:\s*(\{[^}]*\})")
RECURRING_RE = re.compile(r"<!--\s*RECURRING_REMINDER\s*:\s*(\{[^}]*\})\s*-*>")
MISSING_RE = re.compile(r"<!--\s*MISSING_PHONES\s*:\s*(\{[\s\S]*?\})\s*-*>")


def parse_reminders(reply):
    out = []
    for m in REMINDER_RE.finditer(reply):
        try:
            p = json.loads(m.group(1))
            if p.get("send_at"):
                out.append(p)
        except json.JSONDecodeError:
            pass
    return out


def parse_recurring(reply):
    out = []
    for m in RECURRING_RE.finditer(reply):
        try:
            p = json.loads(m.group(1))
            days = p.get("days")
            t = p.get("time", "")
            if (isinstance(p.get("reminder_text"), str)
                and isinstance(days, list)
                and all(isinstance(d, int) and 0 <= d <= 6 for d in days)
                and re.match(r"^\d{1,2}:\d{2}$", t)):
                out.append(p)
        except json.JSONDecodeError:
            pass
    return out


def parse_missing(reply):
    out = []
    for m in MISSING_RE.finditer(reply):
        try:
            p = json.loads(m.group(1))
            if "known" in p and "unknown" in p:
                out.append(p)
        except json.JSONDecodeError:
            pass
    return out


class TestReminderBlocks(unittest.TestCase):
    def test_legacy_block(self):
        r = '<!--REMINDER:{"reminder_text":"x","send_at":"2026-04-22T10:00:00+03:00"}-->'
        got = parse_reminders(r)
        self.assertEqual(len(got), 1)
        self.assertNotIn("delivery_mode", got[0])

    def test_dm_with_recipients(self):
        r = ('<!--REMINDER:{"reminder_text":"x","send_at":"2026-04-22T10:00:00+03:00",'
             '"delivery_mode":"dm","recipient_phones":["972501234567"]}-->')
        got = parse_reminders(r)
        self.assertEqual(got[0]["delivery_mode"], "dm")
        self.assertEqual(got[0]["recipient_phones"], ["972501234567"])

    def test_both_multi_recipient(self):
        r = ('<!--REMINDER:{"reminder_text":"x","send_at":"2026-04-22T10:00:00+03:00",'
             '"delivery_mode":"both","recipient_phones":["972501111111","972502222222"]}-->')
        got = parse_reminders(r)
        self.assertEqual(got[0]["delivery_mode"], "both")
        self.assertEqual(len(got[0]["recipient_phones"]), 2)

    def test_malformed_rejected(self):
        r = '<!--REMINDER:{"reminder_text":"x","send_at":MALFORMED}-->'
        self.assertEqual(parse_reminders(r), [])


class TestRecurringBlocks(unittest.TestCase):
    def test_dm_single_day(self):
        r = ('<!--RECURRING_REMINDER:{"reminder_text":"t","days":[3],"time":"07:00",'
             '"delivery_mode":"dm","recipient_phones":["972501111111"]}-->')
        got = parse_recurring(r)
        self.assertEqual(got[0]["days"], [3])
        self.assertEqual(got[0]["delivery_mode"], "dm")

    def test_invalid_day_rejected(self):
        r = '<!--RECURRING_REMINDER:{"reminder_text":"x","days":[7],"time":"07:00"}-->'
        self.assertEqual(parse_recurring(r), [])


class TestMissingPhonesBlock(unittest.TestCase):
    def test_mixed(self):
        r = ('<!--MISSING_PHONES:{"known":[{"name":"a","phone":"972501"}],'
             '"unknown":["b"],"reminder_text":"x","delivery_mode":"dm",'
             '"send_at_or_recurrence":{"days":[3,4,5],"time":"07:00"}}-->')
        got = parse_missing(r)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["unknown"], ["b"])


if __name__ == "__main__":
    unittest.main()
