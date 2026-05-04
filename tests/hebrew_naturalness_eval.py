"""
Sheli Hebrew Naturalness Eval

Runs each curated case through the configured Sonnet model and scores 4 binary
checks: calque-free, no Latin mid-Hebrew, feminine first-person, Haiku-judge
naturalness. Reports per-case pass/fail and aggregate score.

Run:  python tests/hebrew_naturalness_eval.py
Env:  ANTHROPIC_API_KEY (required)
      REPLY_MODEL (default: claude-sonnet-4-20250514)
      JUDGE_MODEL (default: claude-haiku-4-5-20251001)

NOTE on the reference set: this harness ships with 7 illustrative STUB cases
in `tests/fixtures/hebrew_naturalness_cases.json` covering the failure modes
observed in production (calques: "מה על הראש", "אני כאן בשבילך", "תני לי לדעת",
"יום נפלא", "תרגישי חופשייה", "קחי את הזמן שלך" + a feminine-drift case).

To grow to the planned 30 cases, edit that fixture file directly. Each entry
is `{id, category, user_message, bad_reply_observed, ideal_reply,
calques_to_flag, notes}`.

The 7-case stub is enough to smoke-test the full pipeline AND to give a real
baseline number for the Sonnet 4 → 4.6 model-swap decision (PR 3). Expand
the fixture for higher confidence before the anti-calque rule trial (PR 5).
"""
import json
import os
import sys
import re
import time
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    from dotenv import load_dotenv
    # override=True so empty shell env vars don't shadow .env values.
    load_dotenv(Path(__file__).parent.parent / ".env", override=True)
except ImportError:
    pass

import requests

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
REPLY_MODEL = os.environ.get("REPLY_MODEL", "claude-sonnet-4-20250514")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-haiku-4-5-20251001")

FIXTURES = Path(__file__).parent / "fixtures"
CASES_PATH = FIXTURES / "hebrew_naturalness_cases.json"
CALQUE_BANK_PATH = FIXTURES / "hebrew_calque_bank.json"


def _load_cases():
    return json.loads(CASES_PATH.read_text(encoding="utf-8"))


def _load_calque_bank():
    return json.loads(CALQUE_BANK_PATH.read_text(encoding="utf-8"))["calques"]


# ─── Whitelisted Latin proper nouns (subset of SHARED_HEBREW_GRAMMAR rule) ───
LATIN_WHITELIST = {
    "WhatsApp", "Google", "API", "Claude", "iCount", "iPhone",
    "sheli.ai", "Sheli.ai", "OpenAI", "Anthropic", "Calendar",
}
LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9.\-_]*")
HEBREW_RE = re.compile(r"[֐-׿]")


# ─── Scorers ───

def contains_calque(text, bank):
    """Return the first matched calque phrase, or None."""
    for entry in bank:
        if entry["phrase"] in text:
            return entry["phrase"]
    return None


def contains_latin_in_hebrew(text):
    """True if text mixes Hebrew with non-whitelisted Latin tokens."""
    if not HEBREW_RE.search(text):
        return False  # no Hebrew → not a Hebrew-context check
    for tok in LATIN_RE.findall(text):
        if tok in LATIN_WHITELIST:
            continue
        bare = tok.rstrip(".,!?;:")
        if bare in LATIN_WHITELIST:
            continue
        return True
    return False


def has_feminine_first_person(text):
    """Sheli speaking about herself: must use feminine present-tense forms.

    Returns True when no masculine drift is detected. (i.e. "clean")
    """
    masc_drift = [
        "אני חושב ", "אני יודע ", "אני זוכר ", "אני מבין ",
        "אני שולח ", "אני בודק ", "אני מחפש ",
    ]
    # NOTE: "אני רוצה" is gender-invariant in unpointed Hebrew — exclude from drift.
    for m in masc_drift:
        if m in text:
            return False
    return True


def judge_natural_anthropic(user_msg, actual_reply, ideal_reply):
    """Haiku-as-judge: is `actual_reply` natural Hebrew (similar quality to `ideal_reply`)?"""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set in env")
    prompt = f"""User wrote: {user_msg}
Bot replied: {actual_reply}
Ideal reply (for reference): {ideal_reply}

Is the bot's reply natural Hebrew that a native Israeli would say? Answer ONLY "yes" or "no". No explanation.
- "yes" = sounds natural, no English-think calques, appropriate register.
- "no" = stilted, calque-y, robotic, or wrong register."""
    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": JUDGE_MODEL,
            "max_tokens": 8,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=30,
    )
    res.raise_for_status()
    answer = res.json()["content"][0]["text"].strip().lower()
    return answer.startswith("yes")


# ─── Reply generation (calls the configured Sonnet model directly) ───

def generate_reply(user_msg, system_prompt=None):
    """Generate a Sheli-style reply via the configured REPLY_MODEL."""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set in env")
    sys_prompt = system_prompt or (
        "את שלי, עוזרת משפחתית חכמה ב-WhatsApp. תעני בעברית טבעית, חמה, "
        "קצרה. גוף ראשון יחיד נקבה. אל תתרגמי מילולית מאנגלית — תכתבי כמו "
        "ישראלית טבעית."
    )
    res = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": REPLY_MODEL,
            "max_tokens": 256,
            "system": sys_prompt,
            "messages": [{"role": "user", "content": user_msg}],
        },
        timeout=60,
    )
    res.raise_for_status()
    return res.json()["content"][0]["text"].strip()


# ─── Per-case scorer ───

def score_case(case, actual, bank, judge_natural=judge_natural_anthropic):
    calque_found = contains_calque(actual, bank)
    latin_violation = contains_latin_in_hebrew(actual)
    masc_drift = not has_feminine_first_person(actual)
    judge_yes = judge_natural(case["user_message"], actual, case["ideal_reply"])

    return {
        "id": case["id"],
        "actual": actual,
        "calque_clean": calque_found is None,
        "calque_found": calque_found,
        "latin_clean": not latin_violation,
        "feminine_clean": not masc_drift,
        "judge_natural": judge_yes,
        "pass": (calque_found is None) and (not latin_violation) and (not masc_drift) and judge_yes,
    }


# ─── Main runner ───

def _safe_model_id(model):
    """Filename-safe model identifier."""
    return re.sub(r"[^A-Za-z0-9]+", "_", model)


def main():
    cases = _load_cases()
    bank = _load_calque_bank()
    results = []
    print(f"Running {len(cases)} cases against {REPLY_MODEL}...")
    for i, case in enumerate(cases, 1):
        print(f"[{i}/{len(cases)}] {case['id']}: {case['user_message'][:50]}...")
        try:
            actual = generate_reply(case["user_message"])
            r = score_case(case, actual, bank)
        except Exception as e:
            print(f"  ERROR: {e}")
            r = {"id": case["id"], "error": str(e), "pass": False}
        results.append(r)
        time.sleep(1.5)  # Tier 1 rate limit: 5/min

    passed = sum(1 for r in results if r.get("pass"))
    score = passed / len(results) * 100 if results else 0
    print("\n=== RESULTS ===")
    print(f"Model: {REPLY_MODEL}")
    print(f"Passed: {passed}/{len(results)} ({score:.1f}%)")
    print("\nFailures:")
    for r in results:
        if not r.get("pass"):
            print(
                f"  {r['id']}: calque={r.get('calque_found')} "
                f"latin={'X' if not r.get('latin_clean') else 'OK'} "
                f"fem={'X' if not r.get('feminine_clean') else 'OK'} "
                f"judge={'X' if not r.get('judge_natural') else 'OK'}"
            )
            actual_or_err = r.get("actual", r.get("error", ""))
            print(f"    actual: {str(actual_or_err)[:120]}")

    out = FIXTURES / f"naturalness_run_{_safe_model_id(REPLY_MODEL)}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"model": REPLY_MODEL, "score": score, "results": results},
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nWrote run details → {out}")
    return score


if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)
