"""Tests for the import_chat_exports.py reminder materialise path (Bug 2).

Schema reality (reminder_queue):
    id (uuid default), household_id, group_id (NOT NULL), message_text,
    send_at, sent (bool), sent_at, reminder_type CHECK IN
    ('event','briefing','summary','nudge','user'), reference_id, created_at,
    created_by_phone, created_by_name.

The previous body used the historical names scheduled_for / status / fired_at
which never matched production columns. Every chat-imported reminder failed
silently with a 400 and the user lost the asked-for nudge. This test pins
the corrected payload shape so the bug can't regress unnoticed.

Run: python -m unittest tests.test_import_reminder_schema -v
"""
from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))


class ImportReminderSchemaTests(unittest.TestCase):
    def setUp(self):
        # Stub out network/Supabase calls inside _common before importing the script.
        self._common_patches = [
            patch("_common.sb_get", return_value=[]),
            patch("_common.sb_post", return_value=None),
            patch("_common.sb_patch", return_value=None),
            patch("_common.message_already_imported", return_value=False),
            patch("_common.haiku_classify", return_value={"intent": "ignore"}),
            patch("_common.sonnet_generate", return_value=""),
        ]
        for p in self._common_patches:
            p.start()
        # Force fresh module load so patched references are used.
        if "import_chat_exports" in sys.modules:
            del sys.modules["import_chat_exports"]
        self.mod = importlib.import_module("import_chat_exports")

    def tearDown(self):
        for p in self._common_patches:
            p.stop()

    # ── helpers ─────────────────────────────────────────────────────────────

    @staticmethod
    def _future_iso() -> str:
        return "2099-01-01T10:00:00+00:00"

    @staticmethod
    def _past_iso() -> str:
        return "2020-01-01T10:00:00+00:00"

    def _materialise_reminder(self, *, time_iso: str, group_id: str | None,
                              created_by_phone: str | None = "972500000001"):
        """Run materialize_actions for a fake add_reminder cls; return the
        list of payloads sent to sb_post (table='reminder_queue')."""
        cls = {
            "intent": "add_reminder",
            "confidence": 0.9,
            "entities": {"text": "לקחת כדור", "time_iso": time_iso},
        }
        with patch.object(self.mod, "sb_get", return_value=[]) as _, \
             patch.object(self.mod, "sb_post") as post:
            self.mod.materialize_actions(
                household_id="hh_test",
                cls=cls,
                text="תזכירי לי בעוד שעה לקחת כדור",
                ts_iso="2026-04-19T17:00:00+00:00",
                user_name="Netser",
                group_id=group_id,
                created_by_phone=created_by_phone,
            )
            return [c.args for c in post.call_args_list if c.args[0] == "reminder_queue"]

    # ── tests ───────────────────────────────────────────────────────────────

    def test_future_reminder_uses_correct_columns(self):
        calls = self._materialise_reminder(
            time_iso=self._future_iso(),
            group_id="972500000001@s.whatsapp.net",
        )
        self.assertEqual(len(calls), 1, "expected one INSERT into reminder_queue")
        _, payload = calls[0]
        # Required columns are present and named correctly.
        self.assertEqual(payload["group_id"], "972500000001@s.whatsapp.net")
        self.assertEqual(payload["household_id"], "hh_test")
        self.assertEqual(payload["message_text"], "לקחת כדור")
        self.assertEqual(payload["send_at"], self._future_iso())
        self.assertEqual(payload["reminder_type"], "user")
        self.assertEqual(payload["sent"], False)
        self.assertEqual(payload["created_by_phone"], "972500000001")
        self.assertEqual(payload["created_by_name"], "Netser")
        # And the historical bad keys are NOT present.
        self.assertNotIn("scheduled_for", payload)
        self.assertNotIn("status", payload)
        self.assertNotIn("fired_at", payload)

    def test_past_reminder_marked_sent_so_cron_skips(self):
        calls = self._materialise_reminder(
            time_iso=self._past_iso(),
            group_id="972500000001@s.whatsapp.net",
        )
        self.assertEqual(len(calls), 1)
        _, payload = calls[0]
        self.assertEqual(payload["sent"], True)
        self.assertEqual(payload["sent_at"], self._past_iso())

    def test_missing_group_id_skips_silently(self):
        calls = self._materialise_reminder(
            time_iso=self._future_iso(),
            group_id=None,
        )
        # No INSERT — group_id is NOT NULL on reminder_queue.
        self.assertEqual(calls, [], "must skip when group_id is missing")

    def test_group_chat_uses_real_jid(self):
        calls = self._materialise_reminder(
            time_iso=self._future_iso(),
            group_id="120363050000000000@g.us",
        )
        self.assertEqual(len(calls), 1)
        _, payload = calls[0]
        self.assertTrue(payload["group_id"].endswith("@g.us"))


if __name__ == "__main__":
    unittest.main()
