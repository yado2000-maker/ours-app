# Admin Dashboard — Channels Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Channels" section to the admin dashboard at `sheli.ai/?admin=1` showing how the user base splits between 1:1 personal users, group users, and "both" — with onboarding funnel, group-nudge conversion, and retention by channel.

**Architecture:** One new Postgres SECURITY DEFINER RPC (`admin_channel_stats`) following the exact pattern of existing admin RPCs. One new inline section in `AdminDashboard.jsx` reusing the existing `Section`, `StatCard`, `DonutChart`, `Sparkline`, and `DataTable` components. No new tables, no new columns — derives everything from existing data (`households_v2`, `onboarding_conversations`, `whatsapp_config`, `web_sessions`). Fits into the existing period selector (1/7/14/30 days).

**Tech Stack:** Postgres (plpgsql), React 19 + Vite 8, Supabase JS v2, PostHog (no new deps).

**Scope choices (YAGNI):**
- ✅ Channel breakdown (personal-only / group-only / both)
- ✅ Onboarding funnel (existing `onboarding_conversations.state` counts)
- ✅ Group-nudge conversion rate (how many 1:1 users added a group after being nudged)
- ✅ Retention by channel (active in last 7 days ÷ total, per channel)
- ❌ Morning briefing stats — deferred: the briefing feature itself isn't fully built; placeholder columns don't exist yet
- ❌ Revenue per channel — deferred: at 5 beta families with 0 paying subs, the number is always 0

**Out of scope:** any change to bot behavior, any new table/column migration, any frontend language/RTL work (dashboard stays English-only).

---

## Task 0: Pre-flight — understand the current state

**Purpose:** confirm we're starting from a clean main branch.

**Step 1: Verify branch + clean tree**

Run:
```bash
cd "C:\Users\yarond\Downloads\claude code\ours-app"
git status
git log --oneline -3
```

Expected: on `main`, working tree clean, recent commits include `44b7b48 fix: detect Hebrew feminine imperatives...`.

**Step 2: Skim the existing RPC as a reference**

Read the existing function definition to internalize the pattern (admin gate + CTEs + `jsonb_build_object`). Use MCP:
```
mcp__f5337598-8c22-4351-a165-f35cce749e76__execute_sql with:
  SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'admin_funnel_stats';
```

Note: every new RPC must start with the admin gate:
```sql
SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;
```

No `git commit` needed — this is read-only exploration.

---

## Task 1: Define the RPC contract (JSONB shape)

**Purpose:** agree on the data shape before writing SQL or JSX. Everything downstream depends on this.

**Files:**
- Modify: `docs/plans/2026-04-13-admin-channels-section.md` (this file — add the contract below as a committed reference)

**Step 1: Document the contract in this plan file**

Append the following block to the bottom of this file under a new `## Appendix A: RPC contract` heading (so the frontend and SQL tasks reference the same shape):

```json
{
  "period_days": 7,
  "channels": {
    "personal_only": { "households": 3, "active_7d": 2 },
    "group_only":    { "households": 5, "active_7d": 4 },
    "both":          { "households": 2, "active_7d": 2 }
  },
  "funnel_counts": {
    "welcomed":  { "count": 4 },
    "chatting":  { "count": 12 },
    "invited":   { "count": 0 },
    "joined":    { "count": 3 },
    "personal":  { "count": 2 },
    "nudging":   { "count": 1 },
    "sleeping":  { "count": 0 },
    "dormant":   { "count": 0 }
  },
  "group_nudge": {
    "nudged":         8,
    "added_group":    2,
    "conversion_pct": 25.0
  },
  "retention_by_channel": [
    { "channel": "personal_only", "total": 3, "active_7d": 2, "pct": 66.7 },
    { "channel": "group_only",    "total": 5, "active_7d": 4, "pct": 80.0 },
    { "channel": "both",          "total": 2, "active_7d": 2, "pct": 100.0 }
  ]
}
```

**Notes on the shape:**
- `channels.*.active_7d` = count of households with any `whatsapp_messages` or `web_sessions` in the last 7 days (not `p_days` — always 7d, so the retention number is meaningful independent of the period selector).
- `group_nudge.nudged` = `onboarding_conversations` where `context ? 'group_nudge_sent_at'` (jsonb key present).
- `group_nudge.added_group` = subset of the nudged where the same `household_id` now appears with a `@g.us` row in `whatsapp_config`.
- `conversion_pct` = `(added_group / nudged) * 100`, rounded 1 decimal, 0 when `nudged = 0` (divide-by-zero guard).
- `retention_by_channel.pct` = rounded 1 decimal.

**Step 2: Commit the contract**

```bash
git add docs/plans/2026-04-13-admin-channels-section.md
git commit -m "docs: admin channels section plan + RPC contract"
```

---

## Task 2: Write the SQL migration for `admin_channel_stats`

**Files:**
- Apply via MCP: `mcp__f5337598-8c22-4351-a165-f35cce749e76__apply_migration` with `name: admin_channel_stats_v1`

**Step 1: Draft the migration**

The full SQL to submit (do not modify the admin gate — it must be exactly the same pattern as `admin_funnel_stats`):

```sql
CREATE OR REPLACE FUNCTION public.admin_channel_stats(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  result JSONB;
  is_admin BOOLEAN;
  v_active_cutoff timestamptz := now() - interval '7 days';
BEGIN
  -- Admin gate: identical pattern to existing admin_* RPCs
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
  IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;

  WITH
  -- Classify each household into exactly one of three channels.
  classified AS (
    SELECT
      h.id AS household_id,
      EXISTS(
        SELECT 1 FROM whatsapp_config wc
        WHERE wc.household_id = h.id AND wc.group_id LIKE '%@g.us'
      ) AS has_group,
      EXISTS(
        SELECT 1 FROM onboarding_conversations oc
        WHERE oc.household_id = h.id
      ) AS has_personal
    FROM households_v2 h
  ),
  channel AS (
    SELECT
      household_id,
      CASE
        WHEN has_group AND has_personal THEN 'both'
        WHEN has_group AND NOT has_personal THEN 'group_only'
        WHEN has_personal AND NOT has_group THEN 'personal_only'
        ELSE 'unclassified'  -- household with no traffic; excluded below
      END AS channel
    FROM classified
  ),
  -- Active in last 7 days: either a WhatsApp message or a web session.
  active_hh AS (
    SELECT DISTINCT household_id FROM (
      SELECT household_id FROM whatsapp_messages WHERE created_at >= v_active_cutoff
      UNION ALL
      SELECT household_id FROM web_sessions WHERE created_at >= v_active_cutoff AND household_id IS NOT NULL
    ) u
  ),
  channel_agg AS (
    SELECT
      channel,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE household_id IN (SELECT household_id FROM active_hh)) AS active_7d
    FROM channel
    WHERE channel <> 'unclassified'
    GROUP BY channel
  ),
  -- Onboarding funnel: counts per state (same pattern as admin_funnel_stats, period-independent).
  funnel AS (
    SELECT state, COUNT(*) AS cnt
    FROM onboarding_conversations
    GROUP BY state
  ),
  -- Group nudge conversion: nudged = has context.group_nudge_sent_at; converted = household has @g.us group now.
  nudge AS (
    SELECT
      COUNT(*) FILTER (WHERE oc.context ? 'group_nudge_sent_at') AS nudged,
      COUNT(*) FILTER (
        WHERE oc.context ? 'group_nudge_sent_at'
          AND EXISTS (
            SELECT 1 FROM whatsapp_config wc
            WHERE wc.household_id = oc.household_id AND wc.group_id LIKE '%@g.us'
          )
      ) AS added_group
    FROM onboarding_conversations oc
  )
  SELECT jsonb_build_object(
    'period_days', p_days,
    'channels', jsonb_build_object(
      'personal_only', jsonb_build_object(
        'households', COALESCE((SELECT total     FROM channel_agg WHERE channel='personal_only'), 0),
        'active_7d',  COALESCE((SELECT active_7d FROM channel_agg WHERE channel='personal_only'), 0)
      ),
      'group_only', jsonb_build_object(
        'households', COALESCE((SELECT total     FROM channel_agg WHERE channel='group_only'), 0),
        'active_7d',  COALESCE((SELECT active_7d FROM channel_agg WHERE channel='group_only'), 0)
      ),
      'both', jsonb_build_object(
        'households', COALESCE((SELECT total     FROM channel_agg WHERE channel='both'), 0),
        'active_7d',  COALESCE((SELECT active_7d FROM channel_agg WHERE channel='both'), 0)
      )
    ),
    'funnel_counts', COALESCE(
      (SELECT jsonb_object_agg(state, jsonb_build_object('count', cnt)) FROM funnel),
      '{}'::jsonb
    ),
    'group_nudge', (
      SELECT jsonb_build_object(
        'nudged', nudged,
        'added_group', added_group,
        'conversion_pct',
          CASE WHEN nudged = 0 THEN 0
               ELSE ROUND((added_group::numeric / nudged) * 100, 1)
          END
      ) FROM nudge
    ),
    'retention_by_channel', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'channel', channel,
        'total', total,
        'active_7d', active_7d,
        'pct', CASE WHEN total = 0 THEN 0
                    ELSE ROUND((active_7d::numeric / total) * 100, 1)
               END
      ) ORDER BY channel) FROM channel_agg),
      '[]'::jsonb
    )
  ) INTO result;

  RETURN result;
END;
$function$;
```

**Step 2: Apply the migration**

Invoke:
```
mcp__f5337598-8c22-4351-a165-f35cce749e76__apply_migration
  project_id: wzwwtghtnkapdwlgnrxr
  name: admin_channel_stats_v1
  query: <paste the CREATE OR REPLACE above>
```

Expected: `{"success": true}`.

**Step 3: Smoke-test the RPC manually**

Invoke:
```
mcp__f5337598-8c22-4351-a165-f35cce749e76__execute_sql
  project_id: wzwwtghtnkapdwlgnrxr
  query: SELECT admin_channel_stats(7);
```

Expected: a JSONB object matching the Appendix A contract, with real numbers from the database. If the result is `{}`, the caller is not in `admin_users` — that's fine for the service-role MCP call, meaning the gate works; but to see real data, temporarily call with a bypass or check by directly running the inner CTEs.

**Alternative smoke test (bypasses admin gate since MCP uses service_role):**
```sql
WITH classified AS (
  SELECT
    h.id,
    EXISTS(SELECT 1 FROM whatsapp_config wc WHERE wc.household_id = h.id AND wc.group_id LIKE '%@g.us') AS has_group,
    EXISTS(SELECT 1 FROM onboarding_conversations oc WHERE oc.household_id = h.id) AS has_personal
  FROM households_v2 h
)
SELECT
  COUNT(*) FILTER (WHERE has_group AND has_personal) AS both,
  COUNT(*) FILTER (WHERE has_group AND NOT has_personal) AS group_only,
  COUNT(*) FILTER (WHERE has_personal AND NOT has_group) AS personal_only,
  COUNT(*) FILTER (WHERE NOT has_group AND NOT has_personal) AS unclassified
FROM classified;
```

Sanity check: the numbers should add up to the total in `households_v2`. If `unclassified` is high, that means many households exist with neither a bot group nor a 1:1 onboarding conversation — worth flagging but not a blocker.

**Step 4: Commit a SQL snapshot for repo history**

Because Supabase migrations applied via MCP aren't tracked in git automatically, create a snapshot file:

Create: `supabase/migrations/2026_04_13_admin_channel_stats_v1.sql` with the exact same CREATE OR REPLACE SQL from Step 1.

```bash
git add supabase/migrations/2026_04_13_admin_channel_stats_v1.sql
git commit -m "feat(sql): admin_channel_stats RPC — channel breakdown + funnel + nudge conversion"
```

---

## Task 3: Add a thin client helper in `supabase.js`

**Purpose:** keep the RPC name in one place so a future rename touches one file.

**Files:**
- Modify: `src/lib/supabase.js` — add a single export at the bottom of the file, alongside other helpers.

**Step 1: Locate the right place**

Open `src/lib/supabase.js`. Find the section with other RPC-wrapping helpers (around `trackWebSession` at line 221). Add the new helper directly after `trackWebSession`.

**Step 2: Add the helper**

Insert:
```javascript
// Admin dashboard — Channels section data. Returns {} if caller isn't in admin_users.
export const fetchAdminChannelStats = async (days = 7) => {
  const { data, error } = await supabase.rpc("admin_channel_stats", { p_days: days });
  if (error) {
    console.error("[fetchAdminChannelStats]", error);
    return null;
  }
  return data;
};
```

**Step 3: Commit**

```bash
git add src/lib/supabase.js
git commit -m "feat: fetchAdminChannelStats helper for admin RPC"
```

---

## Task 4: Wire the new RPC into `AdminDashboard.jsx` data fetch

**Files:**
- Modify: `src/components/AdminDashboard.jsx` around line 284–310 (the `fetchAll` callback).

**Step 1: Import the helper**

At the top of `AdminDashboard.jsx`, add to the existing import from `../lib/supabase.js`:
```javascript
import { supabase, fetchAdminChannelStats } from "../lib/supabase.js";
```
(If the current import line doesn't include `fetchAdminChannelStats`, add it.)

**Step 2: Add state for channel stats**

Near the other `useState` calls around line 270–274:
```javascript
const [channelStats, setChannelStats] = useState(null);
```

**Step 3: Extend the Promise.all in `fetchAll`**

Find the existing Promise.all (line ~285):
```javascript
const [ovRes, fnRes, ftRes] = await Promise.all([
  supabase.rpc("admin_dashboard_overview", { p_days: period }),
  supabase.rpc("admin_funnel_stats"),
  supabase.rpc("admin_feature_stats", { p_days: period }),
]);
```

Change it to:
```javascript
const [ovRes, fnRes, ftRes, chRes] = await Promise.all([
  supabase.rpc("admin_dashboard_overview", { p_days: period }),
  supabase.rpc("admin_funnel_stats"),
  supabase.rpc("admin_feature_stats", { p_days: period }),
  fetchAdminChannelStats(period),
]);
```

**Step 4: Set the channel stats state**

After the existing `setOverview/setFunnel/setFeatures` calls in `fetchAll`, add:
```javascript
setChannelStats(chRes || null);
```

**Step 5: Smoke-test — dashboard still loads**

Run the dev server:
```bash
npm run dev
```
Navigate to `http://localhost:5173/?admin=1` in a browser where you're signed in as one of the ADMIN_IDS. Expected: dashboard loads same as before (no visible change yet), no console errors. Check the React dev tools or browser console to confirm `channelStats` state is populated with the RPC response.

**Step 6: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat: fetch admin_channel_stats alongside existing admin RPCs"
```

---

## Task 5: Render the "Channels" section — donut + stat cards

**Files:**
- Modify: `src/components/AdminDashboard.jsx` — add new JSX between the existing "App Traffic" section (~line 829) and the "Past Families" section (~line 834).

**Step 1: Build the channel-color constants**

Just above the `return (` in the component (around line 420, before the outer JSX), add:
```javascript
// Channel section constants — reused across donut, stat cards, retention table
const CHANNEL_LABELS = {
  personal_only: "Personal only",
  group_only:    "Group only",
  both:          "Both",
};
const CHANNEL_COLORS = {
  personal_only: "#E8725C", // coral
  group_only:    "#2AB673", // green
  both:          "#5B8DEF", // blue
};
```

**Step 2: Add the JSX for the Channels section**

After the existing `</Section>` that closes "App Traffic" (look for the `<Section title="Past Families"` opening tag — insert immediately before it), add:

```jsx
{/* Section 5b: Channels — 1:1 / group / both breakdown */}
<Section title="Channels" subtitle="How the user base splits between personal and group usage">
  {channelStats ? (
    <>
      {/* Top: 3 stat cards */}
      <div className="adm-grid3" style={{ marginBottom: 16 }}>
        <StatCard
          label="Personal only"
          value={channelStats.channels.personal_only.households}
          sub={`${channelStats.channels.personal_only.active_7d} active this week`}
          color={CHANNEL_COLORS.personal_only}
        />
        <StatCard
          label="Group only"
          value={channelStats.channels.group_only.households}
          sub={`${channelStats.channels.group_only.active_7d} active this week`}
          color={CHANNEL_COLORS.group_only}
        />
        <StatCard
          label="Both channels"
          value={channelStats.channels.both.households}
          sub={`${channelStats.channels.both.active_7d} active this week`}
          color={CHANNEL_COLORS.both}
        />
      </div>

      {/* Middle: donut chart of channel distribution */}
      <div style={{
        background: "var(--white)", borderRadius: "var(--radius-card)",
        boxShadow: "var(--sh)", padding: 20, marginBottom: 16,
        display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap",
      }}>
        <DonutChart
          data={[
            { label: CHANNEL_LABELS.personal_only, value: channelStats.channels.personal_only.households, color: CHANNEL_COLORS.personal_only },
            { label: CHANNEL_LABELS.group_only,    value: channelStats.channels.group_only.households,    color: CHANNEL_COLORS.group_only },
            { label: CHANNEL_LABELS.both,          value: channelStats.channels.both.households,          color: CHANNEL_COLORS.both },
          ]}
          size={160}
        />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Household distribution</div>
          {["personal_only", "group_only", "both"].map((key) => {
            const total = channelStats.channels.personal_only.households
                        + channelStats.channels.group_only.households
                        + channelStats.channels.both.households;
            const n = channelStats.channels[key].households;
            const pct = total === 0 ? 0 : ((n / total) * 100).toFixed(1);
            return (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, fontSize: 14 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: CHANNEL_COLORS[key] }} />
                <span style={{ flex: 1, color: "var(--dark)" }}>{CHANNEL_LABELS[key]}</span>
                <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{n} ({pct}%)</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom: retention by channel table */}
      <div style={{ background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 12px", color: "var(--dark)" }}>7-day retention by channel</h3>
        <DataTable
          columns={[
            { key: "channel", label: "Channel", render: (r) => CHANNEL_LABELS[r.channel] || r.channel },
            { key: "total", label: "Households" },
            { key: "active_7d", label: "Active 7d" },
            { key: "pct", label: "Retention %", render: (r) => `${r.pct}%` },
          ]}
          rows={channelStats.retention_by_channel || []}
          emptyMsg="No channel data yet."
        />
      </div>
    </>
  ) : (
    <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading channels…</p>
  )}
</Section>
```

**Step 3: Smoke-test — section renders**

Still running `npm run dev`, reload `http://localhost:5173/?admin=1`. Expected:
- New "Channels" section appears above "Past Families"
- Three stat cards show numbers (coral / green / blue)
- Donut chart renders with the three slices
- Retention table shows 3 rows (one per channel)
- No console errors

If data shows "Loading channels…" and never resolves → RPC returned `null` (admin gate or error). Open browser devtools Network tab, find the `rpc/admin_channel_stats` POST, check response body.

**Step 4: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat: admin dashboard Channels section — breakdown + donut + retention table"
```

---

## Task 6: Add the Group Nudge conversion card

**Purpose:** visualize `group_nudge.conversion_pct` as a dedicated card — this is the most actionable metric (tells you whether the nudge redesign is working).

**Files:**
- Modify: `src/components/AdminDashboard.jsx` — insert INSIDE the Channels section, between the donut block and the retention table.

**Step 1: Insert the card**

Add this JSX after the donut block and before the retention table (between the two `<div style={{ background: "var(--white)"...}}>` blocks):

```jsx
{/* Group nudge conversion — singles who added Sheli to a group after being nudged */}
<div style={{
  background: "var(--white)", borderRadius: "var(--radius-card)",
  boxShadow: "var(--sh)", padding: 20, marginBottom: 16,
  display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap",
}}>
  <div style={{ flex: 1, minWidth: 200 }}>
    <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px", color: "var(--dark)" }}>Group-nudge conversion</h3>
    <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
      1:1 users who added Sheli to a group after being nudged about it (one-time mention, 2d or 5 actions)
    </p>
  </div>
  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: "var(--dark)", lineHeight: 1 }}>
        {channelStats.group_nudge?.nudged ?? 0}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Nudged</div>
    </div>
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: CHANNEL_COLORS.both, lineHeight: 1 }}>
        {channelStats.group_nudge?.added_group ?? 0}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Added group</div>
    </div>
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: "var(--accent)", lineHeight: 1 }}>
        {(channelStats.group_nudge?.conversion_pct ?? 0).toFixed(1)}%
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Conversion</div>
    </div>
  </div>
</div>
```

**Step 2: Smoke-test**

Reload the dashboard. Expected: card appears between donut and retention table, showing "Nudged / Added group / Conversion".

**Step 3: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat: group-nudge conversion card in Channels section"
```

---

## Task 7: Handle the existing onboarding funnel better (DRY cleanup)

**Purpose:** the new RPC returns `funnel_counts` too (same shape as `admin_funnel_stats`). Don't duplicate — keep using `admin_funnel_stats` for the existing "Onboarding Funnel" section (which has more data — conversations list, avg times). The `channel_stats.funnel_counts` was meant as a convenience if the Channels section wanted to show funnel inline, but we chose NOT to duplicate. Confirm the data is ignored on the client and leave a TODO to remove from the RPC later.

**Files:**
- Modify: `src/components/AdminDashboard.jsx` — just add a comment.

**Step 1: Add an explicit "unused" comment where channelStats is destructured**

In the Channels section JSX, above the donut block, add a one-line comment:
```jsx
{/* NOTE: channelStats.funnel_counts is unused — duplicates admin_funnel_stats. Remove from RPC later. */}
```

**Step 2: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "docs: note duplicated funnel_counts in channel_stats for future cleanup"
```

---

## Task 8: Production verification — deploy and sanity-check

**Files:** none (deployment step).

**Step 1: Push to main**

```bash
git push origin main
```

Vercel auto-deploys on push. Wait ~2 minutes.

**Step 2: Verify on production**

Open `https://sheli.ai/?admin=1` in a browser signed in as one of the ADMIN_IDS. Expected:
- "Channels" section visible between "App Traffic" and "Past Families"
- Numbers match what the MCP smoke-test queries returned in Task 2, Step 3
- Period selector still works (switching 7d/14d/30d doesn't change the Channels numbers — they're period-independent by design, which is correct — but the rest of the dashboard still updates)

**Step 3: Cross-check with raw SQL**

Run the same sanity query from Task 2, Step 3. Compare:
- `personal_only` from query vs card value
- `group_only` from query vs card value
- `both` from query vs card value
- Sum should equal the "Total households" metric in the existing Family Health section

If they don't match, the RPC definition and the client render disagree somewhere — check the JSONB path names against Appendix A.

**Step 4: Update CLAUDE.md with a one-line note**

Add under the existing "Admin dashboard features" bullet or similar location in CLAUDE.md:
```
- **Admin Channels section**: `admin_channel_stats(p_days)` RPC + `AdminDashboard.jsx` section showing 1:1/group/both breakdown, group-nudge conversion, and 7d retention by channel. Deployed 2026-04-13.
```

```bash
git add CLAUDE.md
git commit -m "docs: document admin Channels section in CLAUDE.md"
git push origin main
```

---

## Task 9: Removed-from-design explicit backlog entry

**Files:**
- Modify: `CLAUDE.md` — TODO section.

**Step 1: Add two lines under the existing TODO list**

```
- **Admin dashboard: Morning briefing stats** — design doc §9 metric. Needs: new columns on `onboarding_conversations` (briefing_count, briefing_opted_out) AND the briefing feature itself to be live. Revisit when briefing ships.
- **Admin dashboard: Revenue per channel** — design doc §9 metric. Deferred until ≥10 paying subscriptions (currently 0).
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: backlog the two deferred Channels metrics (briefing stats, revenue)"
git push origin main
```

---

## Verification checklist (at end)

Before declaring done:

- [ ] `admin_channel_stats(7)` returns a valid JSONB matching Appendix A (not `{}` when called as admin)
- [ ] The three household counts (personal_only + group_only + both) sum to a sensible fraction of `households_v2` (unclassified households are expected, but not the majority)
- [ ] The donut slices visually match the stat card numbers
- [ ] The retention table rows sum the same way
- [ ] `group_nudge.conversion_pct` is a number between 0.0 and 100.0 (never NaN, never > 100)
- [ ] Period selector switches still refresh the rest of the dashboard (we didn't break it)
- [ ] No console errors on `/?admin=1`
- [ ] CLAUDE.md updated with what's built + what's backlogged
- [ ] All commits pushed to `main`

---

## Time estimate

| Task | Estimate |
|------|----------|
| 0. Pre-flight | 5 min |
| 1. Contract doc | 10 min |
| 2. SQL RPC | 45 min (writing + smoke test) |
| 3. Client helper | 5 min |
| 4. Wire the fetch | 15 min |
| 5. Render donut + stat cards | 40 min |
| 6. Group nudge card | 15 min |
| 7. DRY comment | 2 min |
| 8. Deploy + verify | 15 min |
| 9. Backlog notes | 5 min |
| **Total** | **~2.5 hours** |

---

## Appendix A: RPC contract

Canonical JSONB shape returned by `admin_channel_stats(p_days)`. Both SQL and JSX must conform to this exactly.

```json
{
  "period_days": 7,
  "channels": {
    "personal_only": { "households": 3, "active_7d": 2 },
    "group_only":    { "households": 5, "active_7d": 4 },
    "both":          { "households": 2, "active_7d": 2 }
  },
  "funnel_counts": {
    "welcomed":  { "count": 4 },
    "chatting":  { "count": 12 },
    "invited":   { "count": 0 },
    "joined":    { "count": 3 },
    "personal":  { "count": 2 },
    "nudging":   { "count": 1 },
    "sleeping":  { "count": 0 },
    "dormant":   { "count": 0 }
  },
  "group_nudge": {
    "nudged":         8,
    "added_group":    2,
    "conversion_pct": 25.0
  },
  "retention_by_channel": [
    { "channel": "personal_only", "total": 3, "active_7d": 2, "pct": 66.7 },
    { "channel": "group_only",    "total": 5, "active_7d": 4, "pct": 80.0 },
    { "channel": "both",          "total": 2, "active_7d": 2, "pct": 100.0 }
  ]
}
```

**Classification logic (households → channel):**
- **`both`** — has BOTH a `@g.us` row in `whatsapp_config` AND an `onboarding_conversations` row
- **`group_only`** — has `@g.us` row, no `onboarding_conversations`
- **`personal_only`** — has `onboarding_conversations`, no `@g.us`
- Households with neither are excluded from all `channels.*` counts

**`active_7d` definition:** any `whatsapp_messages` OR `web_sessions` for that `household_id` in the last 7 days. Fixed 7-day window regardless of `p_days` parameter (retention needs a fixed frame to be meaningful).

**`group_nudge`:**
- `nudged` = `onboarding_conversations` rows where `context ? 'group_nudge_sent_at'`
- `added_group` = subset of nudged whose `household_id` now has a `@g.us` row in `whatsapp_config`
- `conversion_pct` = `(added_group / nudged) * 100`, rounded 1 decimal, returns `0` when `nudged = 0` (no divide-by-zero)

**`retention_by_channel.pct`:** rounded 1 decimal; `0` when `total = 0`.

**Empty-state rule:** all counts default to 0 (not null). Frontend can safely do arithmetic without null-guards.

**Admin gate:** RPC returns `{}` (empty object) when caller is not in `admin_users` table. Frontend helper returns `null` on error; Channels section shows "Loading channels…" if data is null.
