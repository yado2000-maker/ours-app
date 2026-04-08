# Security Audit — Sheli (sheli.ai)

**Date:** 2026-04-08
**Threat model:** Semi-public (hometown launch, referral spread to unknowns)

## Findings Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 3 | Phase 1 fix |
| HIGH | 5 | Phase 1 fix |
| MEDIUM | 9 | Phase 2 fix |
| LOW | 6 | Backlog |
| PASS | 9 | Already secure |

## Phase 1 — Before Hometown Launch

### C1. `household_members` — fully open RLS (`USING: true`)
"Public access fallback" policy allows ANY request (including unauthenticated) to read/write/delete all memberships. Escalates to full data access since other tables use `is_household_member()`.
**Fix:** Drop policy. Replace with scoped policies.

### C2. `households` (legacy blob) — fully open RLS (`USING: true`)
Same as C1. Table is unused but live.
**Fix:** Drop policy. Table should be dropped eventually.

### C3. WhatsApp webhook auth bypass when env var missing
Line 170: `if (!webhookToken) return true;` — accepts all payloads if `WHAPI_WEBHOOK_TOKEN` unset.
**Fix:** Change to `return false` (fail-closed).

### H1. Cross-household data access on core tables
`tasks`, `shopping_items`, `events` all use `auth.uid() IS NOT NULL` — any logged-in user can access any household's data.
**Fix:** Replace with `is_household_member(household_id)` for all CRUD policies.

### H2. 3 tables have RLS completely DISABLED
`classification_corrections`, `global_prompt_proposals`, `household_patterns` — no RLS. `household_patterns` content is injected into AI prompts.
**Fix:** Enable RLS, add household-scoped policies. Bot-only tables get service-role-only access.

### H3. Prompt injection via WhatsApp sender names
Sender name injected unsanitized into Haiku prompt.
**Fix:** Sanitize (strip control chars, limit to 50 chars).

### H4. No webhook message deduplication
Whapi retries cause duplicate processing.
**Fix:** Check `whatsapp_message_id` before processing.

### H5. `.env.local.example` lists `VITE_ANTHROPIC_KEY`
Trap for developers — VITE_ prefix would expose key in client bundle.
**Fix:** Rename to `ANTHROPIC_API_KEY`.

## Upsert-Safe RLS Strategy

The original RLS relaxation was due to Supabase's upsert behavior: `.upsert()` checks INSERT policy first, even for existing rows. If INSERT is stricter than UPDATE, upserts fail silently.

**Solution:** Use the SAME check for INSERT WITH CHECK and UPDATE USING on each table.

### New policy map

| Table | INSERT WITH CHECK | SELECT USING | UPDATE USING | DELETE USING |
|-------|------------------|-------------|-------------|-------------|
| `household_members` | `user_id = auth.uid() OR is_household_member(household_id)` | `is_household_member(household_id)` | `is_household_member(household_id)` | `is_household_member(household_id)` |
| `tasks` | `is_household_member(household_id)` | same | same | same |
| `shopping_items` | `is_household_member(household_id)` | same | same | same |
| `events` | `is_household_member(household_id)` | same | same | same |
| `messages` | `is_household_member(household_id)` | already ✓ | N/A | N/A |
| `households_v2` | `auth.uid() IS NOT NULL` (keep) | `auth.uid() IS NOT NULL` (keep for join flow) | `created_by = auth.uid()` ✓ | `created_by = auth.uid()` ✓ |
| `ai_usage` | `is_household_member(household_id)` | already ✓ | already ✓ | N/A |
| `whatsapp_config` | `is_household_member(household_id)` | already ✓ | already ✓ | N/A |
| `classification_corrections` | enable RLS, bot-only (service_role) | bot-only | bot-only | bot-only |
| `global_prompt_proposals` | enable RLS, bot-only | bot-only | bot-only | bot-only |
| `household_patterns` | enable RLS, bot-only | bot-only | bot-only | bot-only |

### Why this is upsert-safe

1. **tasks/shopping/events:** INSERT and UPDATE both use `is_household_member(household_id)`. Since household_id is invariant across insert/update, both checks pass identically. No asymmetry.

2. **household_members:** The upsert at App.jsx:630 (join flow) uses `ignoreDuplicates: true` → `ON CONFLICT DO NOTHING`. Only INSERT policy is checked: `user_id = auth.uid()` passes because the user inserts themselves.

3. **Setup flow (founder):**
   - Line 321: `await insert({user_id: authUserId})` → `user_id = auth.uid()` ✓
   - Line 326: `insert({role: "member"})` (no user_id) → `is_household_member(household_id)` ✓ (founder row already committed from line 321's await)

## Phase 2 — Within First Week

| # | Issue | Fix |
|---|-------|-----|
| M1 | No rate limiting on webhook | Per-phone rate limit (10 msg/min) |
| M2 | System prompt passthrough in API proxy | Construct server-side |
| M3 | No message length validation | Cap input messages |
| M4 | Household join by guessable ID | Add invitation tokens (future) |
| M5 | Bridge endpoint sends to any phone | Validate phone ownership |
| M6 | Second-order prompt injection | Sanitize stored messages before re-injection |
| M7 | No security headers | Add to vercel.json |
| M8 | iCount webhook no replay protection | Add timestamp check |
| M9 | households_v2 SELECT too broad | Keep for now (needed for join flow) |

## Phase 3 — Before Scaling

- Replace `Math.random()` IDs with `crypto.getRandomValues()`
- Persistent rate limiting (Redis/Supabase)
- Upgrade bot uid4() to uid8()
- Audit PII in logs
