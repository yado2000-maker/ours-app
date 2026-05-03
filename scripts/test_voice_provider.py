"""
Send one audio file to BOTH Groq and ivrit-ai (HF), print both transcripts.

Usage:
  python scripts/test_voice_provider.py <audio.ogg>

Env (loaded from project .env if available):
  GROQ_API_KEY         — Groq Whisper baseline
  IVRIT_AI_HF_URL      — Private HF Inference Endpoint URL
  IVRIT_AI_HF_TOKEN    — HF token with `inference-endpoints` scope

The HF endpoint runs ivrit-ai/whisper-large-v3-turbo on a T4 GPU,
scale-to-zero after 15min idle. First call after idle takes 30-60s
for cold load — hence the 180s timeout below.
"""
import os
import sys
from pathlib import Path

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Load .env if python-dotenv is available
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

import requests  # type: ignore

if len(sys.argv) < 2:
    print("Usage: python scripts/test_voice_provider.py <audio.ogg>")
    sys.exit(1)

audio_path = Path(sys.argv[1])
if not audio_path.exists():
    print(f"ERROR: audio file not found: {audio_path}")
    sys.exit(1)

audio_bytes = audio_path.read_bytes()
print()
print("=== Voice Provider Comparison ===")
print(f"File: {audio_path} ({len(audio_bytes)} bytes)")
print()

# 1. Groq Whisper (baseline)
groq_key = os.environ.get("GROQ_API_KEY", "")
if groq_key:
    files = {"file": (audio_path.name, audio_bytes, "audio/ogg")}
    data = {
        "model": "whisper-large-v3",
        "response_format": "verbose_json",
        "language": "he",
        "temperature": "0",
    }
    try:
        r = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {groq_key}"},
            files=files,
            data=data,
            timeout=120,
        )
        if r.ok:
            out = r.json()
            groq_text = out.get("text", "").strip()
            groq_meta = f"language={out.get('language', 'unknown')}, segments={len(out.get('segments', []))}"
        else:
            groq_text = f"ERROR {r.status_code}: {r.text[:200]}"
            groq_meta = ""
    except Exception as e:
        groq_text = f"EXCEPTION: {e}"
        groq_meta = ""
else:
    groq_text = "GROQ_API_KEY not set"
    groq_meta = ""

print("--- Groq Whisper Large v3 (baseline) ---")
if groq_meta:
    print(f"[{groq_meta}]")
print(groq_text)
print()

# 2. ivrit-ai HF endpoint
url = os.environ.get("IVRIT_AI_HF_URL", "")
tok = os.environ.get("IVRIT_AI_HF_TOKEN", "")
if url and tok:
    try:
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "audio/ogg",
            },
            data=audio_bytes,
            timeout=180,  # 180s for cold-start tolerance
        )
        if r.ok:
            try:
                out = r.json()
                if isinstance(out, dict):
                    ivrit_text = out.get("text", "").strip()
                    chunks = out.get("chunks") or []
                    ivrit_meta = f"chunks={len(chunks)}" if chunks else ""
                else:
                    ivrit_text = str(out)
                    ivrit_meta = "raw response (not dict)"
            except Exception:
                ivrit_text = r.text[:500]
                ivrit_meta = "non-JSON response"
        else:
            ivrit_text = f"ERROR {r.status_code}: {r.text[:200]}"
            ivrit_meta = ""
    except Exception as e:
        ivrit_text = f"EXCEPTION: {e}"
        ivrit_meta = ""
else:
    ivrit_text = "IVRIT_AI_HF_URL or IVRIT_AI_HF_TOKEN not set"
    ivrit_meta = ""

print("--- ivrit-ai/whisper-large-v3-turbo (HF endpoint) ---")
if ivrit_meta:
    print(f"[{ivrit_meta}]")
print(ivrit_text)
print()
