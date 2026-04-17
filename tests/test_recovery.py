"""Offline tests for the recovery toolchain (Capabilities A/B/C).

These tests do NOT hit the network or DB. They verify the pure-Python
parts: chat-export parsing, filename validation, resolution heuristics,
schedule spreading. For end-to-end validation of DB writes, run the
scripts with --dry-run against a staging Supabase project.

Run:
  python -m pytest tests/test_recovery.py -v
  # or, without pytest:
  python tests/test_recovery.py
"""
from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Make `scripts/` importable.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))


class ChatExportParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        from scripts import import_chat_exports as m  # noqa: E501
        self.m = m

    def test_filename_regex_accepts_standard(self) -> None:
        m = self.m.FILENAME_RE.match("972544848291_Noam.txt")
        self.assertIsNotNone(m)
        self.assertEqual(m["phone"], "972544848291")
        self.assertEqual(m["name"], "Noam")

    def test_filename_regex_accepts_phone_only(self) -> None:
        m = self.m.FILENAME_RE.match("972501234567.txt")
        self.assertIsNotNone(m)
        self.assertEqual(m["phone"], "972501234567")
        self.assertIsNone(m["name"])

    def test_filename_regex_accepts_hyphenated_name(self) -> None:
        m = self.m.FILENAME_RE.match("972523955056_Daniel-Cohen.txt")
        self.assertIsNotNone(m)
        self.assertEqual(m["phone"], "972523955056")
        self.assertEqual(m["name"], "Daniel-Cohen")

    def test_filename_regex_rejects_nonsense(self) -> None:
        self.assertIsNone(self.m.FILENAME_RE.match("random.txt"))
        self.assertIsNone(self.m.FILENAME_RE.match("abc_Noam.txt"))

    def test_line_regex_dot_date_with_seconds(self) -> None:
        line = "[17.04.2026, 07:22:14] Hani: תוסיפי חלב"
        m = self.m.LINE_RE.match(line)
        self.assertIsNotNone(m)
        self.assertEqual(m["d"], "17")
        self.assertEqual(m["m"], "04")
        self.assertEqual(m["y"], "2026")
        self.assertEqual(m["H"], "07")
        self.assertEqual(m["M"], "22")
        self.assertEqual(m["S"], "14")
        self.assertEqual(m["sender"].strip(), "Hani")
        self.assertEqual(m["body"], "תוסיפי חלב")

    def test_line_regex_slash_date_no_seconds(self) -> None:
        line = "[17/4/26, 7:22] שלי: הוספתי 💚"
        m = self.m.LINE_RE.match(line)
        self.assertIsNotNone(m)
        self.assertIsNone(m["S"])
        self.assertEqual(m["sender"].strip(), "שלי")
        self.assertEqual(m["body"], "הוספתי 💚")

    def test_parse_export_multiline_body(self) -> None:
        sample = (
            "[17.04.2026, 07:22:14] Hani: תוסיפי לרשימה\n"
            "חלב וביצים\n"
            "[17.04.2026, 07:22:18] שלי: הוספתי!\n"
        )
        tmp = ROOT / "tests" / "_tmp_export.txt"
        tmp.write_text(sample, encoding="utf-8")
        try:
            parsed = self.m.parse_export(tmp)
        finally:
            tmp.unlink(missing_ok=True)

        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["sender"], "Hani")
        self.assertIn("חלב וביצים", parsed[0]["text"])
        self.assertEqual(parsed[1]["sender"], "שלי")
        self.assertEqual(parsed[1]["text"], "הוספתי!")

    def test_is_bot_accepts_sheli_variants(self) -> None:
        self.assertTrue(self.m.is_bot("שלי"))
        self.assertTrue(self.m.is_bot("sheli"))
        self.assertTrue(self.m.is_bot("Sheli"))
        self.assertTrue(self.m.is_bot("SHELI"))
        self.assertFalse(self.m.is_bot("Hani"))
        self.assertFalse(self.m.is_bot("Noam"))

    def test_parse_timestamp_2digit_year(self) -> None:
        ts = self.m.parse_timestamp("17", "4", "26", "7", "22", "14")
        self.assertEqual(ts.year, 2026)
        self.assertEqual(ts.tzinfo, self.m.IL_TZ)

    def test_recovery_state_needs_recovery_when_no_bot_reply(self) -> None:
        thread = [
            {"sender": "Hani", "ts": None, "text": "תוסיפי חלב", "raw_ts_iso": ""},
            {"sender": "Hani", "ts": None, "text": "ולחם", "raw_ts_iso": ""},
        ]
        self.assertEqual(self.m.classify_recovery_state(thread), "needs_recovery")

    def test_recovery_state_handled_when_bot_confirmed(self) -> None:
        thread = [
            {"sender": "Hani", "ts": None, "text": "תזכירי לי לסבתא", "raw_ts_iso": ""},
            {"sender": "שלי",  "ts": None, "text": "רשמתי לך תזכורת 💚", "raw_ts_iso": ""},
        ]
        self.assertEqual(self.m.classify_recovery_state(thread), "handled_manually")

    def test_recovery_state_noise_when_empty_user_msgs(self) -> None:
        thread = [
            {"sender": "Hani", "ts": None, "text": "😊", "raw_ts_iso": ""},
        ]
        self.assertEqual(self.m.classify_recovery_state(thread), "noise_only")


class PlannerScheduleTests(unittest.TestCase):
    def test_stagger_empty(self) -> None:
        from scripts import plan_recovery_messages as p  # noqa: E501
        self.assertEqual(p.stagger_schedule(0, datetime.now(timezone.utc)), [])

    def test_stagger_spreads_across_window(self) -> None:
        from scripts import plan_recovery_messages as p
        start = datetime(2026, 4, 18, 6, 0, tzinfo=timezone.utc)
        times = p.stagger_schedule(24, start, spread_hours=4)
        self.assertEqual(len(times), 24)
        # First within the first 15 min.
        self.assertLess((times[0] - start).total_seconds(), 15 * 60)
        # Last within the spread window (± jitter).
        self.assertLess((times[-1] - start).total_seconds(), 4 * 3600 + 120)
        # Monotonic-ish (allow small jitter regressions).
        prev = times[0] - timedelta(minutes=1)
        for t in times:
            self.assertGreaterEqual(t, prev - timedelta(seconds=61))
            prev = t


class ImporterIdempotencyTests(unittest.TestCase):
    """Sanity tests for the dedup primitives."""

    def test_import_msg_id_is_deterministic(self) -> None:
        from scripts._common import make_import_msg_id
        a = make_import_msg_id("972501234567", "2026-04-17T07:22:14+00:00", "חלב")
        b = make_import_msg_id("972501234567", "2026-04-17T07:22:14+00:00", "חלב")
        self.assertEqual(a, b)
        self.assertTrue(a.startswith("import-"))

    def test_import_msg_id_varies_by_input(self) -> None:
        from scripts._common import make_import_msg_id
        a = make_import_msg_id("972501234567", "2026-04-17T07:22:14+00:00", "חלב")
        b = make_import_msg_id("972501234567", "2026-04-17T07:22:14+00:00", "ביצים")
        c = make_import_msg_id("972509999999", "2026-04-17T07:22:14+00:00", "חלב")
        self.assertNotEqual(a, b)
        self.assertNotEqual(a, c)


if __name__ == "__main__":
    unittest.main(verbosity=2)
