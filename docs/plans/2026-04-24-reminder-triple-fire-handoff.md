# Handoff — Reminder triple-fire bug (2026-04-24)

## TL;DR

Yaron's beta user Adi (972544979523, 1:1) received EACH of her 5 reminders 2–3 times this morning (ביס, חיסון, אוריאל, ספרית, פירות). Also a group echo ("הוספתי לרשימה: סוכר, תחבושות, ניוקי, מגבונים…") posted twice in קניות באושר at 14:31.

User sent ONE message. Bugs are in Sheli's reply + correction flow, not user re-sends.

Evidence was pulled live in session 2026-04-24 AM. All already-fired dupes cannot be undone. Two unsent future dupes (a different user, 972533713966) were soft-cancelled in-session with `superseded_reason='dedup_double_insert_20260424'`.

## Three distinct bugs (confirmed)

### Bug 1 — Double-insert on actionable `add_reminder`

**Symptom:** Two `reminder_queue` rows 34 ms apart, identical `send_at`, text slightly different (one inline, one bulleted list).

**Example row IDs:** `24a9a39f-c863-4314-97b2-15f2c4472949` (created 17:12:55.165) + `e9d25417-6d69-431b-a783-3f83936dedab` (created 17:12:55.199). Group `972544979523@s.whatsapp.net`.

**Cause:** In 1:1 path, both the `add_reminder` actionable-case insert (`execute1on1Actions`, around line ~8295 of `supabase/functions/whatsapp-webhook/index.inlined.ts`) AND `rescueRemindersAndStrip` run on the same Sonnet reply. Rescue is meant to recover `<!--REMINDER:-->` blocks Sonnet emits when Haiku misclassified — but when both fire, you get 2 rows. No `isSameReminder(group_id, send_at, similar_text)` guard exists.

**Fix direction:** Rescue path must skip any `<!--REMINDER:-->` block whose `(group_id, send_at within ±5 min, fuzzy text match)` already exists in `reminder_queue` with `created_at > NOW() - INTERVAL '1 minute'`. Build a tiny `isSameReminder` helper matching the shape of `isSameTask` / `isSameEvent`.

### Bug 2 — "Already-scheduled" short-circuit missing

**Symptom:** 49 min after inserting 4 reminders (16:49), user asked "וגם את אלה תזכירי?" (17:37). Sheli replied "כבר רשמתי!" but ALSO inserted 4 MORE copies with identical `send_at`. Then at 17:42 (after "עשר דקות לפני"), inserted 4 MORE at shifted times.

**Example:** "חיסון לליאו" send_at `2026-04-24 04:45:00+00` appears twice (16:49:01.30 + 17:38:04.71 — 49 min gap, same send_at, same text). Definitely not a 34 ms race.

**Cause:** Sonnet's intent confirmation ("וגם את אלה תזכירי?") gets re-classified as fresh `add_reminder` with the same entities. Haiku can't see the 49-min-old pending rows. The reply reads as "already done" but the action side still inserts.

**Fix direction:** In the `add_reminder` actionable case, before `INSERT INTO reminder_queue`, query for any pending reminder with same `(group_id, fuzzy-match text, send_at within ±15 min)`. If found, skip the INSERT and reply confirming the existing one. Similar logic to the "duplicate handling" the shopping path already has (CLAUDE.md: "כבר ברשימה, להוסיף עוד?").

### Bug 3 — handleCorrection v2 didn't actually soft-cancel

**Symptom:** At 17:41 Adi: "עשית בלאגן שלי" → 17:42:12 Sheli: "מחקתי את הבלגן ושמתי מחדש לפי המסר המקורי שלך". But DB shows NO soft-cancel of the 8 stale rows (16:49 batch + 17:38 batch remain `sent=false` at that moment). Sheli only INSERTed a 3rd batch at corrected times (17:42:08–11).

**Cause:** handleCorrection v2 calls Sonnet structured output to pick a single `target_id`, then `executeCrudAction` soft-cancels just that one. When the user's "delete the mess" implicitly references 8 rows across 4 reminders, Sonnet returns one target_id (or none), and the other 7 stay alive. Cannot cancel multi-target corrections.

**Fix direction:** Extend the structured-output schema to allow `target_ids: string[]` (plural). When the user's correction is broad ("מחקי הכל", "עשית בלגן", "התחילי מחדש"), Sonnet should return all pending reminders for this user today. Or: before inserting a "corrected replacement" set, soft-cancel all pending same-scope (`group_id`, `send_at::date` = today/tomorrow) reminders created in the last 1 h.

## What was done in the handoff session

- Confirmed via `reminder_queue` + `whatsapp_messages` queries that Adi sent ONE message; the 3 waves were Sheli's.
- 2 future unsent dupes soft-cancelled (user 972533713966, rows `a056901d…` + `c8e5f5d7…`).
- No code changes — all 3 bugs are structural and need tests.

## Plan of attack for the fresh session

1. **Read** `supabase/functions/whatsapp-webhook/index.inlined.ts` around these anchors:
   - `execute1on1Actions` `add_reminder` case (~line 8295)
   - `rescueRemindersAndStrip` function
   - `handleCorrection` (v2, Sonnet-structured — see `memory/project_handlecorrection_v2.md`)
2. **Write tests first** in `tests/test_webhook.py` (superpowers:test-driven-development):
   - Test A: user sends 1 message with 4 reminders → expect exactly 4 rows (not 8).
   - Test B: user then sends "וגם את אלה תזכירי?" 1 minute later → expect no new rows + acknowledge reply.
   - Test C: user says "עשית בלגן, מחקי הכל" → expect all pending rows for today soft-cancelled.
   - Test D: user sends "פירות 8:30" → expect 1 row even if Sonnet emits a REMINDER block AND the action path fires.
3. **Implement:**
   - `isSameReminder(group_id, send_at, text)` helper (fuzzy — first 20 chars normalized Hebrew).
   - Pre-INSERT dedup guard in `add_reminder` actionable case.
   - Skip logic in `rescueRemindersAndStrip` when recent identical row exists.
   - Multi-target support in `handleCorrection` structured-output schema.
4. **Deploy** via Cursor→Dashboard paste (see CLAUDE.md deploy notes). Run pre-deploy esbuild parse check. Post-paste scan for `ש` corruption.
5. **Commit** on a feature branch, open PR, merge. No hot-fix.

## Do NOT

- Do not run broad `UPDATE reminder_queue SET sent=true` across historical data — only dedup future unsent rows.
- Do not add a naive UNIQUE constraint on `(group_id, message_text, send_at)` — legitimate "remind me every X min" reminders would collide.
- Do not send Adi an apology DM from code — Yaron can do that manually. Sheli is in recovery posture (see MEMORY: 4-layer kill switch; outbound still paused).

## Files to touch

- `supabase/functions/whatsapp-webhook/index.inlined.ts` (production deploy file)
- `supabase/functions/_shared/*` for dev reference only — don't deploy from here
- `tests/test_webhook.py` — add 4 new cases in a `TestReminderDedup` class

## Reference memory entries

- `memory/project_handlecorrection_v2.md` — current correction flow shape
- `memory/feedback_insert_undo_symmetry.md` — insert/undo path asymmetry is a recurring root cause
- CLAUDE.md "handleCorrection v2 (2026-04-23)" — recent rewrite, relevant context
- CLAUDE.md "reminder_queue schema reality" — columns, drain v4, delivery_mode
