# Hebrew Quality — Voice + Sonnet Naturalness

**Date:** 2026-04-30
**Status:** Plan ready for approval. Both tracks bundled into one combined plan per Yaron's choice; each ships independently in phased PRs.

## Context

Sheli's Hebrew has two distinct quality regressions, each in a different layer:

1. **Sonnet REPLY drift — calques.** Sheli writes English-think Hebrew that's grammatically valid but reads like Google-Translate. Live example: "מה על הראש היום" (literal "what's on your mind today") — natural Hebrew is "מה איתך היום" or "מה יש לך על הראש היום". `SHARED_HEBREW_GRAMMAR` ([index.inlined.ts:1733](supabase/functions/whatsapp-webhook/index.inlined.ts:1733)) has ~25 rules covering gender, slang, prefix bans — **zero coverage of calques**. Every reply on every channel is exposed.

2. **Voice transcription errors — Whisper Large v3 mishears.** Live example: clearly-spoken "אביטל האדריכלית" came back from Groq as "הביטל המדריכלית" — wrong proper noun + wrong profession. Current call ([index.inlined.ts:12204](supabase/functions/whatsapp-webhook/index.inlined.ts:12204)) passes **no `language` hint**, **no `prompt` bias** for household names, default temperature. Downstream Haiku fixer ([line 12329](supabase/functions/whatsapp-webhook/index.inlined.ts:12329)) cannot recover phonemes Whisper never captured. Volume <50/day → cost is irrelevant; quality wins.

Decisions captured from brainstorm:
- **One combined plan, two tracks shipping independently.**
- **Voice path:** hosted ivrit-ai endpoint (no self-hosted infra).
- **Text path:** try Sonnet 4.6 model swap first; only add prompt rules if the swap doesn't fix it.

---

## Track A — Voice transcription (Whisper → ivrit-ai)

### A1. Household name biasing (cheap first ship — half day)

Whisper's `prompt` parameter biases the decoder toward tokens it sees in the prompt — works on **any** Whisper-compatible provider (Groq, OpenAI, ivrit-ai, faster-whisper). No model change needed for this win.

- Before each `transcribeVoice` call, fetch household names from `whatsapp_member_mapping.member_name WHERE household_id = X`.
- Build a Hebrew-comma-separated string: `"אביטל, ירון, נעם, אורטל"`.
- Pass as `prompt` to Groq's existing endpoint. Whisper accepts up to 224 tokens of bias prompt.
- Optionally also include the household name itself + last 5 shopping-item names from `shopping_items` for the household (recent vocabulary).
- Lower temperature to `0.0` (currently default).

Expected lift: 30–50% reduction in proper-noun errors. Zero added latency, zero added cost.

### A2. Swap provider to hosted ivrit-ai endpoint

Replace the Groq Whisper call with a hosted ivrit-ai/whisper-large-v3-ct2 endpoint. ivrit-ai team explicitly fine-tuned Whisper on Hebrew, with documented WER drops vs upstream Whisper.

**Provider research needed before implementation** (one of these):
- **Replicate** — likely simplest. Search for ivrit-ai or community Hebrew-Whisper models. Pay-per-second.
- **Hugging Face Inference Endpoints (dedicated)** — deploy `ivrit-ai/whisper-large-v3-ct2` with scale-to-zero. ~$0/idle, GPU on first hit.
- **Hugging Face Inference API (serverless)** — cheapest but cold-start prone.

Refactor pattern: introduce `transcribeVoice` provider abstraction matching the existing `whatsapp-provider.ts` pattern. Keep both Groq and ivrit-ai paths behind a `VOICE_PROVIDER` env var so we can flip back if quality regresses.

Keep:
- The existing quality gate (avg_logprob < -1.2 → unclear, no_speech_prob > 0.7 → no_speech).
- The Haiku post-fix pass (`fixVoiceTranscription`) — it solves a different problem (merged words, hallucinated filler).
- The `verbose_json` confidence signals — required for the gate. Verify the chosen ivrit-ai endpoint can return per-segment `avg_logprob` / `no_speech_prob` (faster-whisper exposes them by default).

### A3. Verification (Track A)

- 5 clean Hebrew voice samples + 5 noisy ones (kids in background, low volume), recorded by Yaron. Run through Groq baseline → A1 (Groq + name biasing) → A2 (ivrit-ai + name biasing). Diff transcripts.
- Specific test: re-record the "אביטל האדריכלית" sample. Must come back correctly under A1 (with household members biased) or A2.
- Production canary: flip `VOICE_PROVIDER=ivrit_ai` for one household for a week; query `whatsapp_messages WHERE message_type='voice'` and eyeball.

---

## Track B — Sonnet reply naturalness (calques)

Yaron chose "3 then 1": try newer Sonnet first, add prompt rules only if needed. **A small eval harness is the prerequisite for both** — without it we can't tell if the model swap helped.

### B1. Reference set + eval harness (~half day)

- Pull 30 known-bad bot replies from `whatsapp_messages WHERE sender_phone = BOT_PHONE` recent enough that the trigger context is reconstructible. Aim for variety: greetings, confirmations, error replies, suggestions.
- For each, write the natural-Hebrew version Yaron would have written. This serves both as few-shot reference AND as the eval target.
- Build `tests/hebrew_naturalness_eval.py` modeled on `tests/test_webhook.py`:
  - Replays each captured `(context, user_msg, bad_reply, ideal_reply)` through whichever Sonnet model is currently configured.
  - Scoring: 4 simple binary checks per output — (a) no English calque from the bank below, (b) no Latin-letter mid-sentence (already enforced server-side, sanity check), (c) Sheli's first-person verbs feminine, (d) closeness to ideal (Haiku-as-judge: "is this natural Hebrew? y/n").
  - Reports score + per-case diff.
- Calque bank to check (initial seed, expand from real data): `מה על הראש`, `אעדכן אותך בחזרה`, `תני לי לדעת`, `אני כאן בשבילך` (sometimes a calque, sometimes fine — context-sensitive), `יום נפלא`, `יש לי שאלה בשבילך`, `רגע מהיר`, `קח את הזמן שלך`.

### B2. Sonnet 4.6 model-swap trial

Per `claude-api` skill: the bot currently uses `claude-sonnet-4-20250514` (the original Sonnet 4). The latest Sonnet is `claude-sonnet-4-6`. Per CLAUDE.md, Opus 4.7 exists but no Sonnet 4.7.

- Swap the model ID in the Sonnet reply call sites (group `buildReplyPrompt` and `ONBOARDING_1ON1_PROMPT` callers). One env var: `REPLY_MODEL=claude-sonnet-4-6`.
- Re-run B1 eval harness. Compare scores.
- Decision rule:
  - **Score lift ≥ 30% on naturalness:** ship the swap. Skip B3.
  - **Lift < 30%:** keep current model, proceed to B3. (Still consider whether the marginal cost of 4.6 is worth even a small lift.)
- Latency / cost watch: Sonnet 4.6 is slightly slower / more expensive than 4. Measure p50 reply latency on canary household for 24h before declaring shippable.

### B3. Anti-calque rule block (only if B2 underperforms)

Add a new section near the **top** of `SHARED_HEBREW_GRAMMAR` (recency bias matters in long prompts):

```
- ANTI-CALQUE (DIRECT-TRANSLATION) RULES — DO NOT translate English idioms word-for-word:
  - "what's on your mind today" → NOT "מה על הראש היום". Use "מה איתך היום" / "מה קורה" / "מה יש לך על הראש היום" (the latter only with "יש לך").
  - "let me know" → NOT "תני לי לדעת". Use "תגידי לי" / "עדכני אותי" / "תכתבי לי".
  - "I'll get back to you" → NOT "אחזור אליך". Use "אכתוב לך אחר כך" / "אענה לך מיד כשאדע".
  - "I'm here for you" → NOT "אני כאן בשבילך" (calque-y). Use "אני איתך" or just answer the question.
  - "have a great day" → NOT "יום נפלא". Use "יום טוב" / "שיהיה לך יום טוב".
  - "take your time" → NOT "קחי את הזמן שלך". Use "אין לחץ" / "בקצב שלך".
  - "quick question" → NOT "שאלה מהירה". Use "שאלה קטנה" / "שאלה אחת".
  - [Expand bank from B1 captured data — 15-25 entries.]
- Rule of thumb: if a phrase translates word-for-word from English and you're not sure if it sounds natural, it probably doesn't. Reach for a Hebrew-native rephrasing.
```

- Re-run eval harness. Confirm lift.
- Watch token budget: this section adds ~400-600 tokens. `SHARED_HEBREW_GRAMMAR` is currently ~2.5K tokens. Acceptable.

### B4. Verification (Track B)

- Eval harness baseline → +B2 model swap → +B3 rules. Score must improve at each step or we don't ship that step.
- Run existing 47-case integration tests (`python tests/test_webhook.py`) — make sure classifier paths still work after model swap.
- Pre-deploy `index.inlined.ts` parse-check ritual: esbuild bundle test → Deno module-load test → live HTTP smoke test (per CLAUDE.md v263 lesson).
- 24h canary on Yaron's own household before broader deploy.

---

## Critical files

- `supabase/functions/whatsapp-webhook/index.inlined.ts`:
  - Voice path: [`transcribeVoice` line 12204](supabase/functions/whatsapp-webhook/index.inlined.ts:12204), [`fixVoiceTranscription` line 12329](supabase/functions/whatsapp-webhook/index.inlined.ts:12329).
  - Hebrew rules: [`SHARED_HEBREW_GRAMMAR` line 1733](supabase/functions/whatsapp-webhook/index.inlined.ts:1733).
  - Sonnet call sites: search for `claude-sonnet-4-20250514` (model ID hardcoded today).
- `tests/hebrew_naturalness_eval.py` — new. Pattern from existing `tests/classifier_eval.py` and `tests/test_webhook.py`.
- `docs/plans/2026-04-30-hebrew-quality-design.md` — formal spec doc, written after this plan is approved.

## Existing patterns to reuse

- **Provider abstraction:** [`supabase/functions/_shared/whatsapp-provider.ts`](supabase/functions/_shared/whatsapp-provider.ts) — same shape for `transcribeVoice` provider swap.
- **Eval harness:** [`tests/classifier_eval.py`](tests/classifier_eval.py), [`tests/test_webhook.py`](tests/test_webhook.py) — Tier 1 batch-of-5 + 65s pause pattern.
- **Shared prompt constants:** the `SHARED_*` anti-drift pattern (CLAUDE.md, 2026-04-16) — any new rule block must be added to the shared constant, not duplicated.
- **claude-api skill** — invoke for the Sonnet 4 → 4.6 migration; it handles Anthropic SDK changes + prompt-cache implications.

## Verification (combined)

```bash
# Baseline
python tests/hebrew_naturalness_eval.py            # establishes pre-change score
python tests/test_webhook.py                        # 47-case integration; must stay ~94%+

# After each Track A or B step
python tests/hebrew_naturalness_eval.py            # must improve
python tests/test_webhook.py                        # must not regress

# Pre-deploy index.inlined.ts (per CLAUDE.md v263 lesson)
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle \
  --platform=neutral --format=esm --target=esnext --loader:.ts=ts \
  --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
"/c/Users/yarond/AppData/Local/Microsoft/WinGet/Packages/DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe/deno.exe" \
  run --no-lock --allow-env --allow-net --import-map=/tmp/v263_repro/import_map.json --check=none \
  supabase/functions/whatsapp-webhook/index.inlined.ts
# After deploy: live HTTP smoke test
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/whatsapp-webhook" \
  -H "Content-Type: application/json" -d '{"event":{"type":"messages","message":[]}}' --max-time 10
# expect 200; rollback via Dashboard deployment history if not
```

End-to-end smoke (manual):
- Send "אביטל האדריכלית" voice → Sheli should echo correctly post-A1.
- Send a casual greeting → Sheli's reply must not contain a known calque from the bank.

## Open decisions (resolve before writing implementation plan)

1. **Hosted ivrit-ai endpoint provider** — Replicate vs HF Inference Endpoint vs other. Need a 30-min research pass: which has ivrit-ai/whisper-large-v3-ct2 already deployed, with a stable API and verbose-json equivalent. Document choice + cost in the spec doc.
2. **Sonnet model decision** — driven by eval data; not pre-committed.
3. **Voice biasing scope** — household member names only, or also include recent shopping items + group title? Bigger context = more bias headroom but also more risk of injecting unrelated bias. Default to names-only first; expand if name accuracy alone isn't enough.
4. **Eval reference set source** — Yaron-curated or auto-extracted-then-Yaron-reviewed. Auto-extract is faster but Yaron's eye is what defines "natural Hebrew" for Sheli.

## Sequencing (suggested PR order)

1. PR 1 — Track A1: household name biasing on existing Groq call. Smallest, fastest, ships in hours.
2. PR 2 — Track B1: eval harness + 30 reference cases. Pre-req for B2.
3. PR 3 — Track B2: Sonnet 4.6 model-swap trial via env var. Toggle, measure, decide.
4. PR 4 — Track A2: ivrit-ai endpoint behind VOICE_PROVIDER env var.
5. PR 5 — Track B3 (only if needed): anti-calque rule block.

Each PR has its own canary + verification. None depend on the others except B2 needing B1.
