# Google Calendar Sync — Demo-Minimum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimum Google Calendar integration required to pass Google's OAuth verification for the `calendar.events` sensitive scope — a "Sync to Google Calendar" button on event cards that creates events in the user's calendar via Google's API.

**Architecture:** Web app requests `calendar.events` scope at Google sign-in time. Supabase Auth returns `provider_token` (Google access_token, 1hr lifetime) in the session. A new Supabase Edge Function (`google-calendar-sync`) accepts an access_token + event details from the web app and creates the event via `POST https://www.googleapis.com/calendar/v3/calendars/primary/events`. WeekView.jsx renders a per-event sync button. No refresh tokens, no auto-sync, no DB persistence in this phase — that's a follow-up post-verification.

**Tech Stack:** React 19, Supabase Auth (Google OAuth), Supabase Edge Function (Deno), Google Calendar API v3.

**Scope boundary:** This plan covers ONLY what's needed to record the demo video and pass verification. After approval, a follow-up plan (`docs/plans/2026-XX-XX-google-calendar-production-plan.md`) will add refresh token storage, auto-sync from the bot, disconnect UI, and bot-side `add_event` integration.

---

## Pre-flight checks

Before writing any code:

- [ ] **Confirm OAuth client config in Google Cloud Console**
  - Open https://console.cloud.google.com/auth/clients/335137917291-uiqesscu911cqc06vc3opumaicklldch.apps.googleusercontent.com?project=project-b9d745d1-d659-49e6-947
  - Authorized redirect URIs MUST include `https://auth.sheli.ai/auth/v1/callback`. If only the legacy `wzwwtghtnkapdwlgnrxr.supabase.co` URL is there, add the auth.sheli.ai one before proceeding (auth domain is live since 2026-04-27).
  - Note the `client_secret` ending `****M3jd` — you don't need it for the demo (no refresh tokens), but the production phase will need it.

- [ ] **Add Yaron's test Google account as Test User**
  - Open https://console.cloud.google.com/auth/audience?project=project-b9d745d1-d659-49e6-947
  - Audience tab → Test users → Add user → enter the test Google email (the one Yaron will use to film the demo)
  - Test users can use sensitive scopes WITHOUT verification (up to 100 test users). This is what unblocks filming.

- [ ] **Confirm Calendar API is enabled in the project**
  - Open https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=project-b9d745d1-d659-49e6-947
  - Status should show "API Enabled". If not, click "Enable".

If any pre-flight item fails, STOP and resolve before proceeding to Task 1.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/components/AuthScreen.jsx` | Modify (line 180-183) | Add `scopes: 'calendar.events'` to `signInWithOAuth` options |
| `src/App.jsx` | Modify (boot useEffect ~line 130, plus pass-through to WeekView) | Capture `session.provider_token` into React state, pass to WeekView |
| `src/components/WeekView.jsx` | Modify (line 148-180 area) | Render "Sync to Google Calendar" button on event cards; call Edge Function |
| `src/lib/google-calendar.js` | Create | Client-side helper that calls the Edge Function with token + event payload |
| `supabase/functions/google-calendar-sync/index.ts` | Create | Edge Function: receives access_token + event JSON, calls Google Calendar API, returns event link |
| `src/locales/he.js`, `src/locales/en.js` | Modify | Add strings: `syncToGcal`, `gcalSynced`, `gcalSyncFailed` |

No DB schema changes in this phase. No new tables.

---

## Task 1: Add `calendar.events` scope to Google OAuth

**Files:**
- Modify: `src/components/AuthScreen.jsx:180-183`

- [ ] **Step 1: Edit handleGoogle to request calendar.events scope**

Change the `signInWithOAuth` call to include scope and force consent:

```jsx
const { error } = await supabase.auth.signInWithOAuth({
  provider: "google",
  options: {
    redirectTo: redirectUrl,
    scopes: "https://www.googleapis.com/auth/calendar.events",
    queryParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },
});
```

Why each piece:
- `scopes`: tells Google to request the sensitive scope. The consent screen will list "See, edit, share, and permanently delete all the calendars you can access using Google Calendar".
- `access_type: "offline"`: required for Google to issue a refresh_token. We don't use it in this phase but it's harmless and avoids a re-prompt later.
- `prompt: "consent"`: forces the consent screen to appear EVERY sign-in, even for users who've granted before. Critical for demo recording — without it, a previously-consented test account skips the consent screen and the video doesn't show it.

- [ ] **Step 2: Manual smoke test (no automated tests for this — it's a UI redirect flow)**

```bash
npm run dev
```

Open http://localhost:5173, click "Sign in with Google", pick a Google account.

Expected: consent screen appears showing TWO scopes — basic profile + "See, edit, share, and permanently delete all the calendars you can access using Google Calendar". If you only see the profile scope, the change didn't take effect — restart the dev server and clear localStorage.

- [ ] **Step 3: Commit**

```bash
git add src/components/AuthScreen.jsx
git commit -m "feat(auth): request calendar.events scope for Google sync"
```

---

## Task 2: Capture provider_token from Supabase session

**Files:**
- Modify: `src/App.jsx` (boot useEffect around line 130-200)

- [ ] **Step 1: Add a state variable for the Google access token**

Near the other useState declarations (around line 96):

```jsx
const [googleAccessToken, setGoogleAccessToken] = useState(null);
```

- [ ] **Step 2: Capture provider_token from session**

In the boot useEffect, find where `supabase.auth.getSession()` resolves. The session object has `provider_token` after Google OAuth. Add:

```jsx
const session = data?.session;
if (session?.provider_token) {
  setGoogleAccessToken(session.provider_token);
}
```

Also add the same capture in the `onAuthStateChange` listener so it picks up the token after the OAuth redirect completes.

- [ ] **Step 3: Console-log to verify (will remove in step 5)**

After `setGoogleAccessToken`:

```jsx
console.log("[gcal] provider_token captured, length:", session.provider_token?.length);
```

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Sign in via Google (if already signed in, sign out first, clear localStorage, sign in again).
Open browser DevTools console.

Expected: `[gcal] provider_token captured, length: <something around 200-250>`. If undefined or null, check that the OAuth flow completed (URL no longer has `code=` query param) and that the scope was actually granted on the consent screen.

- [ ] **Step 5: Remove the console.log, commit**

```bash
git add src/App.jsx
git commit -m "feat(app): capture Google access_token from Supabase session"
```

---

## Task 3: Create the google-calendar-sync Edge Function

**Files:**
- Create: `supabase/functions/google-calendar-sync/index.ts`

- [ ] **Step 1: Create the function file**

Create `supabase/functions/google-calendar-sync/index.ts`:

```typescript
// ============================================================================
// Google Calendar Sync Edge Function
//
// Accepts: { accessToken: string, event: { title, scheduledFor, durationMinutes? } }
// Calls: POST https://www.googleapis.com/calendar/v3/calendars/primary/events
// Returns: { ok: true, htmlLink: string, eventId: string } or { ok: false, error }
//
// No env vars needed — token comes from request body. RLS not applicable
// (function authenticated by Supabase JWT verification — Settings → Verify JWT ON).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface SyncRequest {
  accessToken: string;
  event: {
    title: string;
    scheduledFor: string;  // ISO 8601, e.g. "2026-05-01T11:00:00+03:00"
    durationMinutes?: number;  // default 60
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "POST only" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: SyncRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { accessToken, event } = body;
  if (!accessToken || !event?.title || !event?.scheduledFor) {
    return new Response(JSON.stringify({ ok: false, error: "missing fields" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const startIso = event.scheduledFor;
  const startMs = new Date(startIso).getTime();
  if (isNaN(startMs)) {
    return new Response(JSON.stringify({ ok: false, error: "invalid scheduledFor" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const endMs = startMs + (event.durationMinutes ?? 60) * 60_000;
  const endIso = new Date(endMs).toISOString();

  const gcalRes = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: event.title,
        start: { dateTime: startIso, timeZone: "Asia/Jerusalem" },
        end: { dateTime: endIso, timeZone: "Asia/Jerusalem" },
        source: { title: "Sheli", url: "https://sheli.ai" },
      }),
    }
  );

  if (!gcalRes.ok) {
    const errBody = await gcalRes.text();
    console.error("[gcal-sync] Google API error:", gcalRes.status, errBody);
    return new Response(
      JSON.stringify({ ok: false, error: "google_api_error", status: gcalRes.status, detail: errBody }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const created = await gcalRes.json();
  return new Response(
    JSON.stringify({ ok: true, htmlLink: created.htmlLink, eventId: created.id }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
```

- [ ] **Step 2: Pre-deploy parse check (mandatory per CLAUDE.md deploy ritual)**

```bash
npx --yes esbuild supabase/functions/google-calendar-sync/index.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/gcal_sync_test.js
```

Expected: `[1 of 1 modules]` no errors. Any syntax error stops the deploy.

- [ ] **Step 3: Deploy via Supabase Dashboard**

Open https://supabase.com/dashboard/project/wzwwtghtnkapdwlgnrxr/functions

Click "Create a new function" → name: `google-calendar-sync` → paste the entire `index.ts` content → Settings → Verify JWT = **ON** (this function should require Sheli auth) → Deploy.

- [ ] **Step 4: Live HTTP smoke test (mandatory per CLAUDE.md deploy ritual)**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/google-calendar-sync" \
  -H "Content-Type: application/json" \
  -d '{}' \
  --max-time 10
```

Expected: `401` (because Verify JWT is on and we sent no auth header). Any other code = problem. `500` = the function crashed at module load (re-read CLAUDE.md "module-load crash" memory).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/google-calendar-sync/index.ts
git commit -m "feat(edge): add google-calendar-sync function"
```

---

## Task 4: Client-side helper for calling the Edge Function

**Files:**
- Create: `src/lib/google-calendar.js`

- [ ] **Step 1: Create the helper**

```javascript
import { supabase } from "./supabase.js";

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-calendar-sync`;

export async function syncEventToGoogleCalendar({ accessToken, event }) {
  const { data: sessionData } = await supabase.auth.getSession();
  const supabaseJwt = sessionData?.session?.access_token;
  if (!supabaseJwt) throw new Error("not_authenticated");

  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${supabaseJwt}`,
    },
    body: JSON.stringify({ accessToken, event }),
  });

  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `http_${res.status}`);
  }
  return json;  // { ok: true, htmlLink, eventId }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/google-calendar.js
git commit -m "feat(lib): client helper for google-calendar-sync"
```

---

## Task 5: Add "Sync to Google Calendar" button to WeekView

**Files:**
- Modify: `src/components/WeekView.jsx` (add prop + button on event cards around line 152-159)
- Modify: `src/App.jsx` (pass `googleAccessToken` to WeekView around line 1036)

- [ ] **Step 1: Pass googleAccessToken prop into WeekView**

In `src/App.jsx:1036`, change:
```jsx
<WeekView tasks={tasks} events={events} rotations={rotations} t={t} lang={lang} onDeleteEvent={deleteEventHandler} />
```
to:
```jsx
<WeekView tasks={tasks} events={events} rotations={rotations} t={t} lang={lang} onDeleteEvent={deleteEventHandler} googleAccessToken={googleAccessToken} />
```

- [ ] **Step 2: Add Google calendar button next to delete button in WeekView**

In `src/components/WeekView.jsx:4`, add prop:
```jsx
export default function WeekView({ tasks, events, rotations, t, lang, onDeleteEvent, googleAccessToken }) {
```

Add an import at the top:
```jsx
import { syncEventToGoogleCalendar } from "../lib/google-calendar.js";
```

Add a state for sync feedback (top of component body):
```jsx
const [syncing, setSyncing] = useState(null);  // event id currently syncing
const [synced, setSynced] = useState({});       // { eventId: htmlLink }

async function handleSync(item) {
  if (!googleAccessToken) {
    alert(t.gcalNotConnected || "התחברו דרך Google כדי לסנכרן ליומן");
    return;
  }
  setSyncing(item.id);
  try {
    const res = await syncEventToGoogleCalendar({
      accessToken: googleAccessToken,
      event: { title: item.title, scheduledFor: item.scheduledFor, durationMinutes: 60 },
    });
    setSynced(prev => ({ ...prev, [item.id]: res.htmlLink }));
  } catch (e) {
    alert((t.gcalSyncFailed || "סנכרון נכשל") + ": " + e.message);
  } finally {
    setSyncing(null);
  }
}
```

Note: add `useState` import if not already present.

In the event card (around line 152-159), add a button BEFORE the delete button:

```jsx
{item._type === "event" && (
  <>
    <button
      onClick={() => handleSync(item)}
      disabled={syncing === item.id || !!synced[item.id]}
      title={synced[item.id] ? (t.gcalSynced || "סונכרן ליומן Google") : (t.syncToGcal || "סנכרון ליומן Google")}
      style={{
        background: "none",
        border: "none",
        cursor: synced[item.id] ? "default" : "pointer",
        color: synced[item.id] ? "var(--accent)" : "var(--muted)",
        fontSize: 12,
        lineHeight: 1,
        padding: 0,
        flexShrink: 0,
        opacity: syncing === item.id ? 0.4 : 0.8,
        marginTop: 1,
      }}
    >
      {synced[item.id] ? "✓📅" : syncing === item.id ? "..." : "📅"}
    </button>
    <button onClick={() => onDeleteEvent(item.id)}
      ...existing delete button...
    </button>
  </>
)}
```

(Replace the existing single delete-button block with this fragment containing both buttons.)

- [ ] **Step 3: Add localized strings**

In `src/locales/he.js`, add:
```js
syncToGcal: "סנכרון ליומן Google",
gcalSynced: "סונכרן ליומן Google",
gcalSyncFailed: "סנכרון נכשל",
gcalNotConnected: "התחברו דרך Google כדי לסנכרן ליומן",
```

In `src/locales/en.js`, add:
```js
syncToGcal: "Sync to Google Calendar",
gcalSynced: "Synced to Google Calendar",
gcalSyncFailed: "Sync failed",
gcalNotConnected: "Sign in with Google to sync to Calendar",
```

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev
```

Sign in with Google (test account, must be added as Test User in Google Cloud Console — see Pre-flight). Add an event in chat ("שלי, פגישה אצל הרופא מחר ב-11"). Open the events tab. Click the 📅 button on the event card.

Expected: button briefly shows "...", then turns to "✓📅" in accent color. Open https://calendar.google.com — the event "פגישה אצל הרופא" appears at 11:00 tomorrow.

If nothing happens, open DevTools Network tab and re-click. The POST to `google-calendar-sync` should return 200 with `{ok:true, htmlLink:..., eventId:...}`.

Common errors:
- `401 Unauthorized` from Google — access_token expired (>1hr after sign-in). Sign out, sign in again.
- `403 Forbidden` from Google — Calendar API not enabled in project, or Test User not added.
- `400 invalid scheduledFor` — event has no `scheduledFor` field. Check the chat-added event in DB.

- [ ] **Step 5: Commit**

```bash
git add src/components/WeekView.jsx src/App.jsx src/lib/google-calendar.js src/locales/he.js src/locales/en.js
git commit -m "feat(events): sync individual events to Google Calendar"
```

---

## Task 6: Push to main and verify on production

- [ ] **Step 1: Open PR**

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr create --title "feat: Google Calendar sync (demo-minimum for verification)" --base main --head "$(git branch --show-current)" --body "$(cat <<'EOF'
## Summary
- Adds `calendar.events` scope to Google OAuth flow
- Captures `provider_token` from Supabase session
- New `google-calendar-sync` Edge Function (Verify JWT on)
- "Sync to Google Calendar" button on event cards in WeekView

## Why
Google rejected the previous OAuth verification submission because the demo video did not sufficiently demonstrate the `calendar.events` scope being used. This PR builds the minimum integration needed to film a passing demo: user grants scope, clicks button, event appears in Google Calendar.

Production-grade integration (refresh tokens, auto-sync, disconnect UI) is deferred to a follow-up plan.

## Test plan
- [x] Pre-flight: Test User added in Google Cloud Console
- [x] Pre-flight: Calendar API enabled
- [x] Manual: sign in with Google → consent screen shows calendar.events scope
- [x] Manual: click Sync button on event → event appears in calendar.google.com
- [x] esbuild parse-check on Edge Function
- [x] Live HTTP smoke test on deployed Edge Function (returns 401 without JWT)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: After Vercel deploy, smoke-test on production**

Wait for Vercel "Ready" notification (~60-90 sec).

Open https://sheli.ai in incognito. Sign in with Google. Verify consent screen shows the calendar scope. Add an event in chat. Click the 📅 button on the event card. Verify event appears in calendar.google.com.

If anything fails, do NOT proceed to demo recording — fix first.

- [ ] **Step 3: Merge PR**

Only after smoke test passes.

```bash
"/c/Users/yarond/gh-cli/bin/gh.exe" pr merge --squash --auto
```

---

## Task 7: Record demo video

- [ ] **Step 1: Reset test account so consent screen re-appears**

Per CLAUDE.md "Auth user reset for clean re-testing":

In Supabase SQL editor, run (replace `<test-email>` with the test Google account email):
```sql
SELECT id, email FROM auth.users WHERE email = '<test-email>';
-- copy the id, then:
DELETE FROM households_v2 WHERE created_by = '<user_id>';
DELETE FROM auth.users WHERE id = '<user_id>';
```

Then revoke at https://myaccount.google.com/permissions while signed in to the same test Google account → find "Sheli" → Remove access.

Both sides must forget or the consent screen won't re-appear.

- [ ] **Step 2: Set up screen recorder**

Use Microsoft Clipchamp (free, on Windows 11):
- Open Clipchamp → "Record screen"
- Pick "Browser tab" or "Window" recording mode
- Set output to 1080p
- Test mic levels (or skip mic — we'll use AI voiceover in editing)

- [ ] **Step 3: Record the demo (silent first pass)**

In Chrome incognito:
1. Navigate to `https://sheli.ai` — pause 2 seconds, scroll down once, scroll back up.
2. Click "Sign in with Google" → pick the freshly-reset test account.
3. **On the consent screen**: pause 5 seconds with cursor hovering over the calendar scope text. Confirm bottom-left language toggle reads **English**. Click "Continue" / "Allow".
4. Land in app → finish household setup quickly.
5. In chat input, type: `שלי, פגישה אצל הרופא מחר ב-11`. Send.
6. Wait for Sheli's reply (~3 sec).
7. Click events tab.
8. Hover over the event, click the 📅 sync button. Wait until ✓📅 appears.
9. Open new tab → `https://calendar.google.com` → wait for it to load → point cursor at the synced event.
10. Stop recording.

Total runtime: ~90-110 seconds.

- [ ] **Step 4: Add narration in Clipchamp**

In Clipchamp editor:
- Drag the recording onto the timeline
- Click "Record & create" → "Text to speech"
- Paste the script from `docs/plans/2026-04-30-google-calendar-sync-plan.md` Task 7 Appendix below
- Pick voice "Davis" or "Guy" (English male)
- Drag the generated voice clip onto a separate audio track
- Align with footage (use ducking on the screen recording's audio if any)
- Export 1080p MP4

- [ ] **Step 5: Upload to YouTube as Unlisted**

- youtube.com/upload
- Visibility: **Unlisted** (NOT public, NOT private)
- Title: "Sheli — Google Calendar OAuth demo"
- Description: paste the script
- Save → copy the `youtu.be/X` short URL

- [ ] **Step 6: Re-submit verification**

In the rejection email, click the "I have fixed the issues" radio button and paste the new YouTube URL into the demo video field. Submit.

---

## Task 7 Appendix: Narration script

```
This is Sheli — a family task coordination utility on WhatsApp and web.
Today I'll demonstrate the Google OAuth flow and how the requested
calendar.events scope is used inside the app.

I'm starting at sheli.ai. I'll click "Sign in with Google" and choose
my test account.

Here is the OAuth consent screen, in English. The user is granting
access to two scopes: their basic profile, and the calendar.events
scope, which lets Sheli create events in their Google Calendar.
I'll click Continue.

After consent, I'm landed in my Sheli household.

Now I'll show how the calendar.events scope is used. I'll ask Sheli
to add a doctor's appointment for tomorrow at 11 AM.

Sheli has added the event. Now I'll open the events tab and click
the Sync to Google Calendar button on this event.

Sheli has just made a POST request to the Google Calendar API
using the user's calendar.events scope. The button now shows
synced.

To verify, I'll open Google Calendar in another tab. The doctor's
appointment is now in the user's calendar at 11 AM tomorrow.

That is the only use of the calendar.events scope in the app.
Thank you for reviewing.
```

---

## Out of scope (post-verification follow-up)

These belong in a separate plan after Google approves the scope:

- **Refresh token storage**: a `google_integrations` table (user_id, refresh_token, scopes, granted_at) with RLS, plus token-refresh logic in the Edge Function.
- **Auto-sync from bot**: when `add_event` action fires AND user has a `google_integrations` row, the Edge Function (`whatsapp-webhook`) calls `google-calendar-sync` automatically. No manual button.
- **Disconnect UI**: settings panel with "Disconnect Google Calendar" that revokes our token via `https://oauth2.googleapis.com/revoke` and deletes the DB row.
- **Conflict handling**: if the user already has an event at that time, surface a warning instead of double-booking.
- **Update/delete propagation**: when user edits or deletes an event in Sheli, mirror to Google Calendar via `PATCH` / `DELETE` on the calendar API.

Don't build any of these in this plan — they're not required for verification, and shipping them before the scope is approved exposes 100+ users to a feature gated on a sensitive scope, which itself is a verification gotcha.

---

## Self-review checklist

- [x] Spec covers: scope expansion, token capture, Edge Function, web UI, demo recording, re-submission
- [x] No placeholders — every step has actual content or commands
- [x] File paths are absolute or workspace-relative; no "see file X" without the path
- [x] Type/method names consistent across tasks (`syncEventToGoogleCalendar`, `googleAccessToken`, `provider_token`)
- [x] Pre-flight gates the work that depends on Google Cloud Console state
- [x] Deploy ritual (esbuild parse-check + live HTTP smoke test) is in Task 3 per CLAUDE.md
- [x] Cleanup of out-of-scope items at the end so future-Yaron knows what NOT to build now
