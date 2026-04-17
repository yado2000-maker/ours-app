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


class GroupExportParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        from scripts import import_chat_exports as m
        self.m = m

    def test_clean_sender_strips_tilde_prefix(self) -> None:
        self.assertEqual(self.m.clean_sender("~ שירה נדב"), "שירה נדב")
        self.assertEqual(self.m.clean_sender("~שירה"), "שירה")
        self.assertEqual(self.m.clean_sender("Tal Kaplan"), "Tal Kaplan")
        self.assertEqual(self.m.clean_sender("\u200e~ Moshe"), "Moshe")

    def test_line_regex_tolerates_ltr_mark_prefix(self) -> None:
        line = "\u200e[17.04.2026, 07:22:14] Tal: שלום"
        m = self.m.LINE_RE.match(line)
        self.assertIsNotNone(m)
        self.assertEqual(m["sender"].strip(), "Tal")

    def test_parse_export_skips_system_messages(self) -> None:
        sample = (
            "[17.04.2026, 07:41:14] ~ שירה נדב: לכבות את ההשקייה בעוד 20 דקות\n"
            "[17.04.2026, 08:23:42] Tal Kaplan: שלי ספרי להם מה את יודעת לעשות\n"
            "[17.04.2026, 08:30:13] sheli: הוספתי משימה לשטוף כלים היום\n"
            "[17.04.2026, 08:41:00] You added Moshe Cohen\n"
            "[17.04.2026, 08:45:12] \u200eMessages and calls are end-to-end encrypted.\n"
            "[17.04.2026, 08:50:00] ~ אלישע נדב: להתקשר לקוחול\n"
        )
        tmp = ROOT / "tests" / "_tmp_group_export.txt"
        tmp.write_text(sample, encoding="utf-8")
        try:
            parsed = self.m.parse_export(tmp)
        finally:
            tmp.unlink(missing_ok=True)

        # 4 real messages (system lines skipped, ~ prefix stripped).
        self.assertEqual(len(parsed), 4)
        senders = [p["sender"] for p in parsed]
        self.assertEqual(senders, ["שירה נדב", "Tal Kaplan", "sheli", "אלישע נדב"])
        self.assertEqual(parsed[-1]["text"], "להתקשר לקוחול")

    def test_parse_export_preserves_multiline_body_in_group(self) -> None:
        sample = (
            "[17.04.2026, 07:22:14] ~ Hani: תוסיפי לרשימה\n"
            "חלב וביצים\n"
            "[17.04.2026, 07:41:00] You removed Hani\n"
            "[17.04.2026, 07:22:18] שלי: הוספתי!\n"
        )
        tmp = ROOT / "tests" / "_tmp_group_multi.txt"
        tmp.write_text(sample, encoding="utf-8")
        try:
            parsed = self.m.parse_export(tmp)
        finally:
            tmp.unlink(missing_ok=True)
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["sender"], "Hani")
        self.assertIn("חלב וביצים", parsed[0]["text"])
        # "You removed Hani" must NOT appear in any body.
        for p in parsed:
            self.assertNotIn("You removed", p["text"])

    def test_synthetic_group_id_is_unique_per_call(self) -> None:
        a = self.m.synthetic_group_id()
        b = self.m.synthetic_group_id()
        self.assertNotEqual(a, b)
        self.assertTrue(a.startswith("group_synthetic_"))
        self.assertTrue(b.startswith("group_synthetic_"))


class GroupResolutionTrackingTests(unittest.TestCase):
    def setUp(self) -> None:
        from scripts import import_chat_exports as m
        self.m = m

    def _make_msg(self, sender: str, text: str, ts: datetime,
                  cls: dict | None = None) -> dict:
        return {
            "sender": sender,
            "ts": ts,
            "text": text,
            "raw_ts_iso": ts.astimezone(timezone.utc).isoformat(),
            "classification": cls,
        }

    def test_low_intent_skipped_from_recovery(self) -> None:
        t0 = datetime(2026, 4, 17, 8, 0, tzinfo=timezone.utc)
        parsed = [
            self._make_msg("Hani", "😊", t0, {"intent": "ignore", "confidence": 0.9}),
            self._make_msg("Hani", "תודה", t0 + timedelta(minutes=2),
                           {"intent": "ignore", "confidence": 0.9}),
        ]
        self.m.resolve_group_messages(parsed, dry_run=True)
        self.assertEqual(parsed[0]["recovery_state"], "low_intent")
        self.assertEqual(parsed[1]["recovery_state"], "low_intent")

    def test_needs_recovery_when_no_bot_reply(self) -> None:
        t0 = datetime(2026, 4, 17, 8, 0, tzinfo=timezone.utc)
        parsed = [
            self._make_msg("Hani", "תזכירי לי להתקשר לקוחול", t0,
                           {"intent": "add_reminder", "confidence": 0.9}),
        ]
        self.m.resolve_group_messages(parsed, dry_run=True)
        self.assertEqual(parsed[0]["recovery_state"], "needs_recovery")

    def test_needs_recovery_when_bot_reply_too_late(self) -> None:
        t0 = datetime(2026, 4, 17, 8, 0, tzinfo=timezone.utc)
        parsed = [
            self._make_msg("Hani", "תזכירי לי להתקשר לקוחול", t0,
                           {"intent": "add_reminder", "confidence": 0.9}),
            self._make_msg("שלי", "רשמתי לך תזכורת להתקשר לקוחול 💚",
                           t0 + timedelta(hours=2)),  # >30min later
        ]
        self.m.resolve_group_messages(parsed, dry_run=True)
        self.assertEqual(parsed[0]["recovery_state"], "needs_recovery")

    def test_handled_when_bot_reply_with_word_overlap(self) -> None:
        t0 = datetime(2026, 4, 17, 8, 0, tzinfo=timezone.utc)
        parsed = [
            self._make_msg("Hani", "תזכירי לי להתקשר לקוחול", t0,
                           {"intent": "add_reminder", "confidence": 0.9}),
            self._make_msg("שלי", "רשמתי לך תזכורת להתקשר לקוחול 💚",
                           t0 + timedelta(minutes=3)),
        ]
        self.m.resolve_group_messages(parsed, dry_run=True)
        self.assertEqual(parsed[0]["recovery_state"], "handled")

    def test_different_user_ask_not_marked_handled(self) -> None:
        t0 = datetime(2026, 4, 17, 8, 0, tzinfo=timezone.utc)
        # Hani asks about reminder; bot replies confirming Tal's shopping item;
        # Hani's ask should stay needs_recovery (no overlap + no LLM in dry_run).
        parsed = [
            self._make_msg("Hani", "תזכירי לי להתקשר לקוחול", t0,
                           {"intent": "add_reminder", "confidence": 0.9}),
            self._make_msg("Tal", "חלב וביצים", t0 + timedelta(minutes=1),
                           {"intent": "add_shopping", "confidence": 0.9}),
            self._make_msg("שלי", "הוספתי חלב וביצים לרשימה",
                           t0 + timedelta(minutes=2)),
        ]
        self.m.resolve_group_messages(parsed, dry_run=True)
        # Hani's message: next bot msg doesn't overlap her text → needs_recovery.
        self.assertEqual(parsed[0]["recovery_state"], "needs_recovery")
        # Tal's message: bot reply overlaps "חלב וביצים" → handled.
        self.assertEqual(parsed[1]["recovery_state"], "handled")


class GroupPlannerTests(unittest.TestCase):
    def test_generate_group_recovery_unified_single_row(self) -> None:
        from scripts import plan_recovery_messages as p
        candidate = {
            "household_id": "hh_test1",
            "group_id": "120363000@g.us",
            "unresolved": [
                {"sender_name": "Hani", "text": "תזכירי לי להתקשר לקוחול",
                 "intent": "add_reminder"},
                {"sender_name": "Tal", "text": "שלי ספרי להם מה את יודעת",
                 "intent": "question"},
                {"sender_name": "אלישע", "text": "להתקשר לקוחול",
                 "intent": "add_reminder"},
            ],
        }
        plan = p.generate_group_recovery(candidate, dry_run=True)
        self.assertIsNotNone(plan)
        self.assertEqual(plan["household_id"], "hh_test1")
        self.assertEqual(plan["group_id"], "120363000@g.us")
        self.assertEqual(sorted(plan["unresolved_names"]),
                         sorted(["Hani", "Tal", "אלישע"]))
        self.assertIn("add_reminder", plan["intents"])

    def test_generate_group_recovery_dedupes_same_sender(self) -> None:
        from scripts import plan_recovery_messages as p
        candidate = {
            "household_id": "hh_x",
            "group_id": "120363000@g.us",
            "unresolved": [
                {"sender_name": "Hani", "text": "קוחול?", "intent": "question"},
                {"sender_name": "Hani", "text": "תזכירי", "intent": "add_reminder"},
            ],
        }
        plan = p.generate_group_recovery(candidate, dry_run=True)
        self.assertIsNotNone(plan)
        self.assertEqual(len(plan["unresolved_names"]), 1)
        self.assertEqual(plan["unresolved_names"], ["Hani"])

    def test_generate_group_recovery_many_users_falls_back_to_generic(self) -> None:
        from scripts import plan_recovery_messages as p
        candidate = {
            "household_id": "hh_big",
            "group_id": "120363000@g.us",
            "unresolved": [
                {"sender_name": f"User{i}", "text": f"ask {i}", "intent": "question"}
                for i in range(7)  # > 5 → generic welcome-back
            ],
        }
        plan = p.generate_group_recovery(candidate, dry_run=True)
        self.assertIsNotNone(plan)
        self.assertIn("חזרתי", plan["body"])
        self.assertEqual(len(plan["unresolved_names"]), 7)

    def test_generate_group_recovery_empty_returns_none(self) -> None:
        from scripts import plan_recovery_messages as p
        plan = p.generate_group_recovery(
            {"household_id": "hh_e", "group_id": "x@g.us", "unresolved": []},
            dry_run=True)
        self.assertIsNone(plan)


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
