# Welcome-Throttle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent WhatsApp bot ban by rate-limiting auto-welcomes to new 1:1 users (6/hr global cap, 30-90s jitter, 3 rotating templates, first-action bundled) after yesterday's FB-driven 500-user surge triggered WhatsApp's anti-spam classifier.

**Architecture:** DB-backed queue (`welcome_queue`) drained by a pg_cron SQL function that calls Whapi via `net.http_post` (matches existing `fire_onboarding_nudge` pattern). Edge Function `handleDirectMessage` classifies the first message via Haiku: actionable intents bundle a one-line intro into the Sonnet reply; everything else inserts a queue row with random delay.

**Tech Stack:** Postgres (pg_cron, pg_net), Deno TypeScript Edge Function, Claude Haiku classifier, Whapi.Cloud.

---

## Task 1: Create welcome_queue table + drain function (DB migration)

**Files:**
- Create: `supabase/migrations/2026_04_18_welcome_queue.sql`

**Acceptance:** Migration applies cleanly. `welcome_queue` table exists with RLS enabled (no policies). Function `drain_welcome_queue()` exists. pg_cron job scheduled every minute.

## Task 2: Modify handleDirectMessage to classify + bundle or queue

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (new-user branch at ~line 3828)

**Behavior:**
- New user → Haiku classify → actionable (`add_shopping|add_task|add_reminder|add_event|add_expense` @ conf≥0.6) falls through to Sonnet 1:1 flow with `first_message_intro=true` context flag. Else inserts `welcome_queue` row with 30-90s jitter + random variant 1-3, state='welcome_queued', returns (no immediate reply).
- Context block for Sonnet adds explicit "FIRST MESSAGE BUNDLE" instruction when flag is true.

## Task 3: Parse check + integration test run

- `npx --yes esbuild ...` — must succeed.
- `python tests/test_webhook.py` — no new regressions.

## Task 4: Commit (no push, no deploy)

Commit message: `feat(bot): welcome-throttle queue + combined first-action reply to prevent WhatsApp spam ban`

## Non-goals / scope guardrails

- No Meta Cloud API work.
- No landing page edits.
- No group-message changes.
- No new intents, new welcome variants beyond 3, or new onboarding UI.
- Retry-on-failure beyond "abandon after 3 attempts" is v1: optimistic `sent_at` set on drain, failures not auto-retried. Good enough for the 24h window.
