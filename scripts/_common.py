"""Shared helpers for recovery scripts (Whapi backlog import, chat export
import, recovery planner).

All three scripts run locally from Git Bash on Yaron's Windows machine.
They talk directly to Supabase REST via the service-role key (bypasses RLS)
and to the Anthropic API for Haiku/Sonnet.

Env vars required (loaded from .env at repo root):
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY
  - ANTHROPIC_API_KEY
  - WHAPI_TOKEN            (backlog importer only)
  - BOT_PHONE_NUMBER       (default 972555175553)
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable

# ─── .env loader (no python-dotenv dependency) ──────────────────────────────

def load_env() -> None:
    """Load .env from the repo root into os.environ (if not already set)."""
    repo_root = Path(__file__).resolve().parents[1]
    env_path = repo_root / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
WHAPI_TOKEN = os.environ.get("WHAPI_TOKEN", "aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m")
BOT_PHONE = os.environ.get("BOT_PHONE_NUMBER", "972555175553")

HAIKU_MODEL = "claude-haiku-4-5-20251001"
SONNET_MODEL = "claude-sonnet-4-20250514"

# Bot display names (used to decide user-vs-bot in chat exports).
BOT_NAMES = {"sheli", "שלי", "Sheli", "Shelly", "Shelley"}

# ─── Supabase REST client ───────────────────────────────────────────────────

try:
    import requests  # type: ignore
except ImportError:
    print("ERROR: requests not installed. pip install requests", file=sys.stderr)
    sys.exit(2)


def _sb_headers(prefer: str | None = None) -> dict[str, str]:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


def sb_get(table: str, params: dict[str, Any] | None = None) -> list[dict]:
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_sb_headers(),
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def sb_post(table: str, rows: dict | list[dict], upsert: bool = False) -> list[dict]:
    prefer = "return=representation"
    if upsert:
        prefer += ",resolution=merge-duplicates"
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_sb_headers(prefer),
        data=json.dumps(rows if isinstance(rows, list) else [rows]).encode("utf-8"),
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"POST {table} failed: {r.status_code} {r.text}")
    return r.json() if r.text else []


def sb_patch(table: str, match: dict[str, Any], patch: dict[str, Any]) -> list[dict]:
    params = {k: f"eq.{v}" for k, v in match.items()}
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=_sb_headers("return=representation"),
        params=params,
        data=json.dumps(patch).encode("utf-8"),
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {table} failed: {r.status_code} {r.text}")
    return r.json() if r.text else []


# ─── Import ID helpers ──────────────────────────────────────────────────────

def make_import_msg_id(sender_phone: str, ts_iso: str, text: str) -> str:
    """Deterministic synthetic ID for messages missing a real whatsapp ID.
    Re-running the importer produces the same ID → insert-ignore dedup.
    """
    h = hashlib.sha1(f"{sender_phone}|{ts_iso}|{text}".encode("utf-8")).hexdigest()[:12]
    return f"import-{h}"


def message_already_imported(whatsapp_message_id: str) -> bool:
    rows = sb_get(
        "whatsapp_messages",
        {"whatsapp_message_id": f"eq.{whatsapp_message_id}", "select": "id", "limit": "1"},
    )
    return len(rows) > 0


# ─── Anthropic API wrappers ─────────────────────────────────────────────────

HAIKU_SYSTEM_PROMPT_MIN = """You are classifying a single Hebrew/English WhatsApp message for a family assistant bot called Sheli.

Output JSON only: {"intent": "<intent>", "confidence": <0-1>, "entities": {...}}

Intents: ignore, add_task, add_shopping, add_event, add_reminder, add_expense,
         complete_task, complete_shopping, question, save_memory, recall_memory.

For shopping: entities.items = ["חלב", "ביצים"].
For tasks/reminders/events: entities.text (Hebrew), entities.time_iso (if time mentioned, ISO 8601 Israel time),
  entities.assigned_to (name if mentioned).
For expenses: entities.amount (number), entities.currency (ILS/USD/EUR), entities.description.

Be conservative. If unsure, use "ignore" with confidence 0.5.
Return ONLY the JSON — no prose, no markdown fence.
"""


def haiku_classify(text: str, sender_name: str = "משתמש") -> dict:
    """Minimal standalone Haiku classifier for recovery. Returns classification dict.
    Falls back to ignore-on-error.
    """
    if not text or not ANTHROPIC_KEY:
        return {"intent": "ignore", "confidence": 0.0, "entities": {}}
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            data=json.dumps({
                "model": HAIKU_MODEL,
                "max_tokens": 400,
                "system": HAIKU_SYSTEM_PROMPT_MIN,
                "messages": [{"role": "user", "content": f"[{sender_name}]: {text}"}],
            }).encode("utf-8"),
            timeout=30,
        )
        r.raise_for_status()
        raw = r.json().get("content", [{}])[0].get("text", "").strip()
        # Strip any accidental fences
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1].lstrip("json").strip().rstrip("`").strip()
        parsed = json.loads(raw)
        return {
            "intent": parsed.get("intent", "ignore"),
            "confidence": float(parsed.get("confidence", 0.5)),
            "entities": parsed.get("entities", {}) or {},
        }
    except Exception as e:
        print(f"  [haiku] error: {e}", file=sys.stderr)
        return {"intent": "ignore", "confidence": 0.0, "entities": {}}


def sonnet_generate(system: str, user: str, max_tokens: int = 400) -> str:
    """One-shot Sonnet call; returns the text content."""
    if not ANTHROPIC_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        data=json.dumps({
            "model": SONNET_MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }).encode("utf-8"),
        timeout=60,
    )
    r.raise_for_status()
    return r.json().get("content", [{}])[0].get("text", "").strip()


# ─── ID helpers ─────────────────────────────────────────────────────────────

def rand_id(prefix: str, length: int = 8) -> str:
    import secrets
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return prefix + "".join(secrets.choice(alphabet) for _ in range(length))


def chunks(seq: list, n: int) -> Iterable[list]:
    for i in range(0, len(seq), n):
        yield seq[i:i + n]
