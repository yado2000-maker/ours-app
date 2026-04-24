"""Normalize WhatsApp chat exports (Android / WhatsApp Web format) for
`import_chat_exports.py`.

Context (2026-04-18): Yaron exported chats from WhatsApp Web to recover the
ban-window backlog. WhatsApp Web uses the Android-style line format:
    DD/MM/YYYY, HH:MM - Sender: body
`import_chat_exports.py` was built for the iOS / WhatsApp Business phone-app
format:
    [DD.MM.YYYY, HH:MM:SS] Sender: body
This script bridges the two: wraps timestamps in `[...]`, writes the output
into `recovery_exports/`, normalizes filenames, and generates
`recovery_exports/manifest.json` with known-household mappings where
applicable.

Usage:
    python scripts/preprocess_whatsapp_exports.py \\
        --source "C:/Users/yarond/Downloads/claude code/_staging_sheli_exports/Sheli chats"

Idempotent: re-running overwrites existing files in `recovery_exports/`.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Known groups from DB (household_id → group_id → display name).
# Populated once from whatsapp_config; update if DB adds more.
KNOWN_GROUPS: dict[str, tuple[str, str]] = {
    # export_filename_stem → (group_id, existing_household_id)
    "חדד": ("120363422354318760@g.us", "hdd8m3kx"),          # Hadad (beta)
    "משפחת כהן": ("120363047065263310@g.us", "hh_a0kr7l3s"),
    "משפחה 🥰": ("120363379191370875@g.us", "hh_cngmjuy9"),
    "משפחת יגלום": ("120363424817327011@g.us", "yg7k2m4x"),
    "משימות": ("120363042618177223@g.us", "hh_apbhifrb"),
    # Added 2026-04-19 (weekend flood batch):
    "הקבוצה של שלי": ("120363426336834114@g.us", "hh_ru7u7f1v"),
    "רומא":         ("120363417763547953@g.us", "hh_4m87fhvn"),
}

# Files to skip entirely (tests/junk).
SKIP_STEMS = {"אני", "בדיקה"}

# Android export line: `DD/MM/YYYY, HH:MM[:SS] - Sender: body`
ANDROID_LINE_RE = re.compile(
    r"^(?P<date>\d{1,2}/\d{1,2}/\d{2,4}),\s*"
    r"(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\s+-\s+(?P<rest>.+)$"
)


def transform_content(raw: str) -> str:
    """Convert Android timestamp format to bracketed iOS format."""
    out: list[str] = []
    for line in raw.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        m = ANDROID_LINE_RE.match(stripped)
        if m:
            out.append(f"[{m.group('date')}, {m.group('time')}] {m.group('rest')}\n")
        else:
            out.append(line)
    return "".join(out)


def phone_from_stem(stem: str) -> str | None:
    """Extract phone number from filenames like '+972 54-696-3617' → '972546963617'."""
    cleaned = re.sub(r"[^\d]", "", stem)
    if cleaned.isdigit() and 10 <= len(cleaned) <= 15:
        # Starts with country code (e.g. 972...); normalize for WhatsApp JID.
        return cleaned
    return None


def slug(name: str) -> str:
    """Ascii-safe filesystem slug (Hebrew → transliteration gaps → underscores)."""
    ascii_only = name.encode("ascii", "replace").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "_", ascii_only).strip("_").lower()
    return s[:40] or "group"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, required=True,
                    help="Folder containing raw 'WhatsApp Chat with X.txt' files.")
    ap.add_argument("--out", type=Path,
                    default=Path(__file__).resolve().parents[1] / "recovery_exports",
                    help="Output folder (default: repo_root/recovery_exports)")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    PREFIX = "WhatsApp Chat with "
    SUFFIX = ".txt"

    manifest_files: list[dict] = []
    used_names: set[str] = set()

    source_files = sorted(args.source.glob(f"{PREFIX}*{SUFFIX}"))
    print(f"Found {len(source_files)} source files in {args.source}")

    for src in source_files:
        stem = src.name[len(PREFIX):-len(SUFFIX)].strip()

        if stem in SKIP_STEMS:
            print(f"  SKIP junk:        {stem}")
            continue

        phone = phone_from_stem(stem)

        if phone:
            out_name = f"{phone}_export.txt"
            entry = {
                "path": out_name,
                "type": "direct",
                "phone": phone,
                "display_name": f"User +{phone}",
            }
            kind_label = f"1:1 phone={phone}"
        else:
            base = slug(stem)
            out_name = f"{base}.txt"
            # Collision suffix
            i = 2
            while out_name in used_names:
                out_name = f"{base}_{i}.txt"
                i += 1
            known = KNOWN_GROUPS.get(stem)
            entry = {
                "path": out_name,
                "type": "group",
                "group_id": known[0] if known else None,
                "existing_household_id": known[1] if known else None,
                "group_name": stem,
            }
            kind_label = f"GROUP ({'known→' + known[1] if known else 'synthetic'})"

        used_names.add(out_name)
        manifest_files.append(entry)

        # Transform + write.
        try:
            raw = src.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            raw = src.read_text(encoding="utf-8", errors="replace")
        transformed = transform_content(raw)
        (args.out / out_name).write_text(transformed, encoding="utf-8")

        print(f"  {kind_label:<30} | {stem[:40]:<40} → {out_name}")

    # Write manifest.
    manifest = {"files": manifest_files}
    manifest_path = args.out / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    n_direct = sum(1 for e in manifest_files if e["type"] == "direct")
    n_known = sum(1 for e in manifest_files if e["type"] == "group" and e["existing_household_id"])
    n_synthetic = sum(1 for e in manifest_files if e["type"] == "group" and not e["existing_household_id"])

    print(f"\nWrote {len(manifest_files)} files + manifest.json to {args.out}")
    print(f"  1:1 direct:          {n_direct}")
    print(f"  Groups (known):      {n_known}")
    print(f"  Groups (synthetic):  {n_synthetic}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
