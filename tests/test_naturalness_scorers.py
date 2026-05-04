"""Unit tests for the scoring primitives used by hebrew_naturalness_eval.py.

These tests are pure (no API calls). Run via:
    python -m pytest tests/test_naturalness_scorers.py -v
"""
import json
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Import the SUT
sys.path.insert(0, str(Path(__file__).parent))
from hebrew_naturalness_eval import (  # noqa: E402
    contains_calque,
    contains_latin_in_hebrew,
    has_feminine_first_person,
    score_case,
)

CALQUE_BANK = json.loads(
    (Path(__file__).parent / "fixtures" / "hebrew_calque_bank.json").read_text(encoding="utf-8")
)["calques"]


# ─── contains_calque ───

def test_contains_calque_detects_known_phrase():
    assert contains_calque("מה על הראש היום?", CALQUE_BANK) == "מה על הראש"


def test_contains_calque_returns_none_for_clean_text():
    assert contains_calque("מה איתך היום?", CALQUE_BANK) is None


def test_contains_calque_known_limitation_substring_match():
    # KNOWN LIMITATION: exact-substring matching means "יש לך משהו על הראש"
    # does NOT contain the exact phrase "מה על הראש" → returns None.
    # A future refinement could add context-aware matching.
    assert contains_calque("יש לך משהו על הראש?", CALQUE_BANK) is None


def test_contains_calque_detects_let_me_know_feminine():
    assert contains_calque("תני לי לדעת מתי תסיימי", CALQUE_BANK) == "תני לי לדעת"


def test_contains_calque_detects_im_here_for_you():
    assert contains_calque("אני כאן בשבילך תמיד 💛", CALQUE_BANK) == "אני כאן בשבילך"


# ─── contains_latin_in_hebrew ───

def test_contains_latin_in_hebrew_flags_mid_sentence():
    assert contains_latin_in_hebrew("היי technologia") is True


def test_contains_latin_in_hebrew_allows_whitelisted_proper_nouns():
    # WhatsApp, Google, sheli.ai, etc. are allowed mid-sentence.
    assert contains_latin_in_hebrew("שלחתי לך ב-WhatsApp") is False
    assert contains_latin_in_hebrew("היכנסי ל-sheli.ai") is False


def test_contains_latin_in_hebrew_pure_latin_returns_false():
    # Not a Hebrew context → not a violation.
    assert contains_latin_in_hebrew("hello world") is False


def test_contains_latin_in_hebrew_pure_hebrew_returns_false():
    assert contains_latin_in_hebrew("שלום, מה שלומך?") is False


def test_contains_latin_in_hebrew_strips_trailing_punctuation():
    # Trailing punctuation on a whitelisted proper noun should still pass.
    assert contains_latin_in_hebrew("היכנסי ל-sheli.ai.") is False


# ─── has_feminine_first_person ───

def test_has_feminine_first_person_passes_for_feminine():
    assert has_feminine_first_person("הוספתי לרשימה, בודקת את התזכורת") is True


def test_has_feminine_first_person_flags_masculine_drift_choshev():
    # Sheli is feminine; "אני חושב" = masculine drift.
    assert has_feminine_first_person("אני חושב שזה בסדר") is False


def test_has_feminine_first_person_flags_masculine_drift_zocher():
    assert has_feminine_first_person("אני זוכר את זה") is False


def test_has_feminine_first_person_allows_ratze():
    # "אני רוצה" is gender-invariant in unpointed Hebrew — must NOT be flagged.
    assert has_feminine_first_person("אני רוצה לעזור לך") is True


# ─── score_case ───

def test_score_case_aggregates_all_four():
    case = {
        "id": "case_001",
        "user_message": "היי שלי",
        "ideal_reply": "היי 💛 מה איתך?",
    }
    actual = "מה על הראש היום?"
    result = score_case(case, actual, CALQUE_BANK, judge_natural=lambda *_: False)
    assert result["calque_clean"] is False
    assert result["calque_found"] == "מה על הראש"
    assert result["pass"] is False


def test_score_case_clean_reply_passes():
    case = {
        "id": "case_002",
        "user_message": "היי שלי",
        "ideal_reply": "היי 💛 מה איתך?",
    }
    actual = "היי 💛 מה איתך?"
    result = score_case(case, actual, CALQUE_BANK, judge_natural=lambda *_: True)
    assert result["calque_clean"] is True
    assert result["calque_found"] is None
    assert result["latin_clean"] is True
    assert result["feminine_clean"] is True
    assert result["judge_natural"] is True
    assert result["pass"] is True


def test_score_case_judge_failure_blocks_pass():
    # Even with all primitives clean, judge=no should fail the case.
    case = {
        "id": "case_003",
        "user_message": "היי שלי",
        "ideal_reply": "היי 💛 מה איתך?",
    }
    actual = "שלום."
    result = score_case(case, actual, CALQUE_BANK, judge_natural=lambda *_: False)
    assert result["pass"] is False
    assert result["judge_natural"] is False


def test_score_case_masculine_drift_blocks_pass():
    case = {
        "id": "case_004",
        "user_message": "שלי, את זוכרת?",
        "ideal_reply": "אני לא זוכרת",
    }
    actual = "אני חושב שלא"
    result = score_case(case, actual, CALQUE_BANK, judge_natural=lambda *_: True)
    assert result["feminine_clean"] is False
    assert result["pass"] is False


# ─── judge_natural_comparative_anthropic ───

def test_judge_comparative_passes_when_actual_wins():
    """Judge says 'A' (actual wins) → pass."""
    from hebrew_naturalness_eval import judge_natural_comparative_anthropic
    import unittest.mock as mock
    fake_response = mock.MagicMock()
    fake_response.json.return_value = {"content": [{"text": "A"}]}
    fake_response.raise_for_status = mock.MagicMock()
    with mock.patch("requests.post", return_value=fake_response):
        result = judge_natural_comparative_anthropic("user", "actual", "ideal")
    assert result is True


def test_judge_comparative_passes_when_tie():
    """Judge says 'tie' → pass (actual is at least as natural)."""
    from hebrew_naturalness_eval import judge_natural_comparative_anthropic
    import unittest.mock as mock
    fake_response = mock.MagicMock()
    fake_response.json.return_value = {"content": [{"text": "tie"}]}
    fake_response.raise_for_status = mock.MagicMock()
    with mock.patch("requests.post", return_value=fake_response):
        result = judge_natural_comparative_anthropic("user", "actual", "ideal")
    assert result is True


def test_judge_comparative_fails_when_ideal_wins():
    """Judge says 'B' (ideal wins) → fail."""
    from hebrew_naturalness_eval import judge_natural_comparative_anthropic
    import unittest.mock as mock
    fake_response = mock.MagicMock()
    fake_response.json.return_value = {"content": [{"text": "B"}]}
    fake_response.raise_for_status = mock.MagicMock()
    with mock.patch("requests.post", return_value=fake_response):
        result = judge_natural_comparative_anthropic("user", "actual", "ideal")
    assert result is False
