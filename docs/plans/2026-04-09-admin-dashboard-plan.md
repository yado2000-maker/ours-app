# Admin Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a live admin analytics dashboard inside the Sheli web app showing family health, activity, funnel, feature adoption, AI costs, and referrals.

**Architecture:** Admin screen in React app, gated by auth user ID. Three `SECURITY DEFINER` PostgreSQL RPC functions bypass RLS for cross-household aggregations. Each function checks `auth.uid()` against `admin_users` table. Frontend renders SVG sparklines and CSS-based charts — no external chart libraries.

**Tech Stack:** React 19, Supabase RPC (`.rpc()`), PostgreSQL functions, inline SVG, CSS variables from existing design system.

**Admin user ID:** `28daa344-ad5a-449b-8e36-f6296bb2f51c` (Yaron)

---

### Task 1: Create `admin_users` table

**Files:**
- Migration via Supabase MCP `apply_migration`

**Step 1: Apply migration**

```sql
-- Admin users table (RLS enabled, no policies = service_role + SECURITY DEFINER only)
CREATE TABLE IF NOT EXISTS admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Seed: Yaron
INSERT INTO admin_users (user_id) VALUES ('28daa344-ad5a-449b-8e36-f6296bb2f51c');
```

**Step 2: Verify**

Run SQL: `SELECT * FROM admin_users;`
Expected: 1 row with Yaron's UUID.

**Step 3: Commit**

```bash
git add -A && git commit -m "chore: add admin_users table with seed data"
```

---

### Task 2: Create `admin_dashboard_overview` RPC function

**Files:**
- Migration via Supabase MCP `apply_migration`

**Step 1: Apply migration**

```sql
CREATE OR REPLACE FUNCTION admin_dashboard_overview(p_days INT DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSONB;
  is_admin BOOLEAN;
BEGIN
  -- Security gate
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
  IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;

  WITH
  -- Total households (exclude sentinel 'unknown')
  total_hh AS (
    SELECT COUNT(*) AS cnt FROM households_v2 WHERE id != 'unknown'
  ),
  -- Active households: any whatsapp_message OR web message in last p_days days
  active_wa AS (
    SELECT DISTINCT household_id FROM whatsapp_messages
    WHERE created_at >= now() - (p_days || ' days')::INTERVAL
      AND household_id != 'unknown'
  ),
  active_web AS (
    SELECT DISTINCT household_id FROM messages
    WHERE created_at >= now() - (p_days || ' days')::INTERVAL
  ),
  active_hh AS (
    SELECT DISTINCT household_id FROM (
      SELECT household_id FROM active_wa
      UNION
      SELECT household_id FROM active_web
    ) combined
  ),
  -- Paying households
  paying_hh AS (
    SELECT COUNT(DISTINCT household_id) AS cnt FROM subscriptions
    WHERE (status = 'active' AND plan != 'free')
       OR (free_until IS NOT NULL AND free_until > now())
  ),
  -- Messages per day (last 14 days, both sources)
  wa_daily AS (
    SELECT created_at::date AS day, COUNT(*) AS cnt
    FROM whatsapp_messages
    WHERE created_at >= now() - INTERVAL '14 days'
      AND classification != 'received'
      AND household_id != 'unknown'
    GROUP BY day
  ),
  web_daily AS (
    SELECT created_at::date AS cnt_day, COUNT(*) AS cnt
    FROM messages
    WHERE created_at >= now() - INTERVAL '14 days'
    GROUP BY cnt_day
  ),
  daily_combined AS (
    SELECT d::date AS day,
      COALESCE((SELECT cnt FROM wa_daily WHERE wa_daily.day = d::date), 0) AS wa,
      COALESCE((SELECT cnt FROM web_daily WHERE web_daily.cnt_day = d::date), 0) AS web
    FROM generate_series(
      (now() - INTERVAL '13 days')::date,
      now()::date,
      '1 day'::INTERVAL
    ) d
  ),
  -- Bot heartbeat: last whatsapp message received
  bot_heartbeat AS (
    SELECT MAX(created_at) AS last_msg FROM whatsapp_messages
  ),
  -- Per-household details
  hh_details AS (
    SELECT
      h.id,
      h.name,
      h.created_at AS joined_at,
      (SELECT COUNT(*) FROM household_members hm WHERE hm.household_id = h.id) AS member_count,
      (SELECT COUNT(*) FROM whatsapp_messages wm
       WHERE wm.household_id = h.id
         AND wm.created_at >= now() - (p_days || ' days')::INTERVAL
         AND wm.classification != 'received') AS wa_msgs_period,
      (SELECT COUNT(*) FROM messages m
       WHERE m.household_id = h.id
         AND m.created_at >= now() - (p_days || ' days')::INTERVAL) AS web_msgs_period,
      (SELECT MAX(wm.created_at) FROM whatsapp_messages wm WHERE wm.household_id = h.id) AS last_wa,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.household_id = h.id) AS last_web
    FROM households_v2 h
    WHERE h.id != 'unknown'
    ORDER BY wa_msgs_period DESC
  ),
  -- Weekly active trend (last 8 weeks)
  weekly_active AS (
    SELECT
      date_trunc('week', d.week_start) AS week,
      (SELECT COUNT(DISTINCT household_id) FROM whatsapp_messages
       WHERE created_at >= d.week_start AND created_at < d.week_start + INTERVAL '7 days'
         AND household_id != 'unknown'
         AND classification != 'received') AS active_count
    FROM generate_series(
      date_trunc('week', now() - INTERVAL '7 weeks'),
      date_trunc('week', now()),
      '1 week'::INTERVAL
    ) d(week_start)
  )
  SELECT jsonb_build_object(
    'total_households', (SELECT cnt FROM total_hh),
    'active_households', (SELECT COUNT(*) FROM active_hh),
    'paying_households', (SELECT cnt FROM paying_hh),
    'messages_by_day', (SELECT jsonb_agg(jsonb_build_object('day', day, 'wa', wa, 'web', web) ORDER BY day) FROM daily_combined),
    'bot_last_message_at', (SELECT last_msg FROM bot_heartbeat),
    'household_details', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'joined_at', joined_at, 'member_count', member_count,
      'wa_msgs', wa_msgs_period, 'web_msgs', web_msgs_period,
      'last_active', GREATEST(last_wa, last_web)
    ) ORDER BY wa_msgs_period DESC), '[]'::jsonb) FROM hh_details),
    'weekly_active_trend', (SELECT COALESCE(jsonb_agg(jsonb_build_object('week', week, 'count', active_count) ORDER BY week), '[]'::jsonb) FROM weekly_active),
    'period_days', p_days
  ) INTO result;

  RETURN result;
END;
$$;
```

**Step 2: Verify**

Run SQL: `SELECT admin_dashboard_overview(7);`
Expected: JSON with total_households, active_households, messages_by_day array, household_details array.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: admin_dashboard_overview RPC function"
```

---

### Task 3: Create `admin_funnel_stats` RPC function

**Files:**
- Migration via Supabase MCP `apply_migration`

**Step 1: Apply migration**

```sql
CREATE OR REPLACE FUNCTION admin_funnel_stats()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSONB;
  is_admin BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
  IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;

  WITH
  funnel AS (
    SELECT
      state,
      COUNT(*) AS cnt,
      AVG(message_count) AS avg_messages,
      AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600) AS avg_hours_in_state
    FROM onboarding_conversations
    GROUP BY state
  ),
  totals AS (
    SELECT COUNT(*) AS total FROM onboarding_conversations
  ),
  -- Time from welcome to onboarded (for those who made it)
  converted AS (
    SELECT
      AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600) AS avg_hours_to_convert,
      AVG(message_count) AS avg_msgs_to_convert
    FROM onboarding_conversations
    WHERE state IN ('onboarded', 'active')
  )
  SELECT jsonb_build_object(
    'funnel_counts', (
      SELECT jsonb_object_agg(state, jsonb_build_object('count', cnt, 'avg_messages', ROUND(avg_messages::numeric, 1)))
      FROM funnel
    ),
    'total_conversations', (SELECT total FROM totals),
    'avg_hours_to_convert', (SELECT ROUND(avg_hours_to_convert::numeric, 1) FROM converted),
    'avg_msgs_to_convert', (SELECT ROUND(avg_msgs_to_convert::numeric, 1) FROM converted),
    'conversations', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'phone', LEFT(phone, 6) || '****',
        'state', state,
        'messages', message_count,
        'referral', referral_code,
        'started', created_at,
        'updated', updated_at
      ) ORDER BY created_at DESC), '[]'::jsonb)
      FROM onboarding_conversations
    )
  ) INTO result;

  RETURN result;
END;
$$;
```

**Step 2: Verify**

Run SQL: `SELECT admin_funnel_stats();`
Expected: JSON with funnel_counts per state, total_conversations, conversion metrics.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: admin_funnel_stats RPC function"
```

---

### Task 4: Create `admin_feature_stats` RPC function

**Files:**
- Migration via Supabase MCP `apply_migration`

**Step 1: Apply migration**

```sql
CREATE OR REPLACE FUNCTION admin_feature_stats(p_days INT DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSONB;
  is_admin BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM admin_users WHERE user_id = auth.uid()) INTO is_admin;
  IF NOT is_admin THEN RETURN '{}'::JSONB; END IF;

  WITH
  -- Intent distribution from classification_data JSONB
  intents AS (
    SELECT
      classification_data->>'intent' AS intent,
      COUNT(*) AS cnt
    FROM whatsapp_messages
    WHERE classification_data IS NOT NULL
      AND classification_data->>'intent' IS NOT NULL
      AND created_at >= now() - (p_days || ' days')::INTERVAL
    GROUP BY intent
    ORDER BY cnt DESC
  ),
  -- Classification distribution (pipeline routing)
  classifications AS (
    SELECT classification, COUNT(*) AS cnt
    FROM whatsapp_messages
    WHERE classification IS NOT NULL
      AND classification != 'received'
      AND created_at >= now() - (p_days || ' days')::INTERVAL
    GROUP BY classification
    ORDER BY cnt DESC
  ),
  -- Per-household feature usage
  hh_features AS (
    SELECT
      h.id,
      h.name,
      (SELECT COUNT(*) FROM tasks t WHERE t.household_id = h.id AND t.created_at >= now() - (p_days || ' days')::INTERVAL) AS tasks_created,
      (SELECT COUNT(*) FROM shopping_items s WHERE s.household_id = h.id AND s.created_at >= now() - (p_days || ' days')::INTERVAL) AS shopping_added,
      (SELECT COUNT(*) FROM events e WHERE e.household_id = h.id AND e.created_at >= now() - (p_days || ' days')::INTERVAL) AS events_created,
      (SELECT COUNT(*) FROM reminder_queue r WHERE r.household_id = h.id AND r.created_at >= now() - (p_days || ' days')::INTERVAL) AS reminders_set,
      (SELECT COUNT(*) FROM rotations ro WHERE ro.household_id = h.id AND ro.active = true) AS active_rotations,
      (SELECT COUNT(*) FROM classification_corrections cc WHERE cc.household_id = h.id) AS corrections
    FROM households_v2 h
    WHERE h.id != 'unknown'
  ),
  -- AI cost estimation
  -- haiku_* classifications = Haiku call (~$0.0003)
  -- sonnet_* classifications = Sonnet call (~$0.01)
  -- direct_address_reply = Sonnet call
  ai_costs AS (
    SELECT
      COUNT(*) FILTER (WHERE classification LIKE 'haiku_%') AS haiku_calls,
      COUNT(*) FILTER (WHERE classification LIKE 'sonnet_%' OR classification = 'direct_address_reply') AS sonnet_calls,
      COUNT(*) FILTER (WHERE classification = 'haiku_ignore') AS ignore_count,
      COUNT(*) FILTER (WHERE classification IS NOT NULL AND classification != 'received') AS total_classified
    FROM whatsapp_messages
    WHERE created_at >= now() - (p_days || ' days')::INTERVAL
  ),
  -- Daily AI cost for sparkline (last 14 days)
  daily_ai AS (
    SELECT
      d::date AS day,
      (SELECT COUNT(*) FROM whatsapp_messages wm
       WHERE wm.created_at::date = d::date AND wm.classification LIKE 'haiku_%') AS haiku,
      (SELECT COUNT(*) FROM whatsapp_messages wm
       WHERE wm.created_at::date = d::date
         AND (wm.classification LIKE 'sonnet_%' OR wm.classification = 'direct_address_reply')) AS sonnet
    FROM generate_series(
      (now() - INTERVAL '13 days')::date,
      now()::date,
      '1 day'::INTERVAL
    ) d
  ),
  -- Referral stats
  ref_stats AS (
    SELECT
      (SELECT COUNT(*) FROM households_v2 WHERE referral_code IS NOT NULL AND id != 'unknown') AS codes_generated,
      (SELECT COUNT(*) FROM referrals WHERE status = 'completed') AS completed,
      (SELECT COUNT(*) FROM referrals) AS total_referrals
  )
  SELECT jsonb_build_object(
    'intent_distribution', (SELECT COALESCE(jsonb_object_agg(intent, cnt), '{}'::jsonb) FROM intents),
    'classification_distribution', (SELECT COALESCE(jsonb_object_agg(classification, cnt), '{}'::jsonb) FROM classifications),
    'household_features', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id, 'name', name,
      'tasks', tasks_created, 'shopping', shopping_added,
      'events', events_created, 'reminders', reminders_set,
      'rotations', active_rotations, 'corrections', corrections
    ) ORDER BY tasks_created + shopping_added + events_created DESC), '[]'::jsonb) FROM hh_features),
    'ai_costs', (SELECT jsonb_build_object(
      'haiku_calls', haiku_calls,
      'sonnet_calls', sonnet_calls,
      'ignore_count', ignore_count,
      'total_classified', total_classified,
      'estimated_cost_usd', ROUND((haiku_calls * 0.0003 + sonnet_calls * 0.01)::numeric, 4),
      'ignore_rate_pct', CASE WHEN total_classified > 0
        THEN ROUND((ignore_count * 100.0 / total_classified)::numeric, 1) ELSE 0 END
    ) FROM ai_costs),
    'daily_ai_costs', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'day', day,
      'haiku', haiku,
      'sonnet', sonnet,
      'cost', ROUND((haiku * 0.0003 + sonnet * 0.01)::numeric, 4)
    ) ORDER BY day), '[]'::jsonb) FROM daily_ai),
    'referrals', (SELECT jsonb_build_object(
      'codes_generated', codes_generated,
      'completed', completed,
      'total', total_referrals,
      'conversion_pct', CASE WHEN total_referrals > 0
        THEN ROUND((completed * 100.0 / total_referrals)::numeric, 1) ELSE 0 END
    ) FROM ref_stats),
    'period_days', p_days
  ) INTO result;

  RETURN result;
END;
$$;
```

**Step 2: Verify**

Run SQL: `SELECT admin_feature_stats(7);`
Expected: JSON with intent_distribution, ai_costs, referrals, household_features.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: admin_feature_stats RPC function"
```

---

### Task 5: Create AdminDashboard.jsx — Hero Banner + Activity Pulse

**Files:**
- Create: `src/components/AdminDashboard.jsx`

**Step 1: Create the component**

Build `AdminDashboard.jsx` with:
- State: `overview` (from `admin_dashboard_overview`), `period` (7/14/30), `loading`, `lastRefresh`
- Auto-refresh every 60s via `setInterval`
- Period selector buttons (Today/7d/30d)
- Admin guard: `ADMIN_IDS` array, check `session.user.id`

**Hero Banner** — 3 big stat cards:
- Total Families (from `overview.total_households`)
- Active Families with period label (from `overview.active_households`)
- Paying Families (from `overview.paying_households`)

**Weekly Active Trend** — SVG sparkline from `overview.weekly_active_trend`:
- `<svg>` with `<polyline>` plotted from weekly counts
- X-axis: week labels, Y-axis: implied by line height
- Green line on light green background

**Activity Pulse**:
- Messages sparkline (14-day from `overview.messages_by_day`, stacked WA + web)
- Bot heartbeat indicator (green dot if `bot_last_message_at` < 10 min ago, yellow < 1h, red otherwise)
- Per-household table: name, WA msgs, web msgs, last active, members — sortable by clicking column headers

**Styling**: Use existing CSS variables (`--primary`, `--accent`, `--dark`, `--cream`, `--border`, `--sh`). Full-width layout (no `max-width: 480px` constraint — admin needs space). Dark theme support via existing `[data-theme]` vars.

**Step 2: Verify component renders**

Temporarily add to App.jsx: `if (screen === "admin") return <AdminDashboard session={session} />;`
Navigate to app, open console: `setScreen("admin")` — verify it renders.

**Step 3: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat: AdminDashboard component — hero banner + activity pulse"
```

---

### Task 6: Add Onboarding Funnel section

**Files:**
- Modify: `src/components/AdminDashboard.jsx`

**Step 1: Add funnel fetch and render**

- Fetch `admin_funnel_stats()` alongside overview
- Render horizontal funnel bars:
  - Each state gets a bar, width proportional to count (widest = 100%)
  - Colors: `--accent` gradient fading lighter per step
  - Label: state name (Hebrew-friendly), count, % of previous step
- Stats row: avg messages to convert, avg hours to convert
- Conversations table: masked phone, state, message count, referral code, dates

**Step 2: Verify**

Reload admin screen, verify funnel renders with real data from `onboarding_conversations` (15 rows).

**Step 3: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat: admin dashboard — onboarding funnel section"
```

---

### Task 7: Add Feature Adoption + AI Cost sections

**Files:**
- Modify: `src/components/AdminDashboard.jsx`

**Step 1: Add feature stats fetch and render**

Fetch `admin_feature_stats(period)` alongside other calls.

**Feature Adoption:**
- Donut chart (CSS `conic-gradient` on a circle div) showing intent distribution
  - Each slice = intent type, color from a preset palette
  - Legend beside the donut with intent name + count + %
- Per-household feature table: name, tasks, shopping, events, reminders, rotations, corrections
- Web vs WA indicator (from overview household_details: wa_msgs vs web_msgs)

**AI Cost Control:**
- Big number: `estimated_cost_usd` this period (formatted as $X.XX)
- Mini cards row: Haiku calls | Sonnet calls | Escalation rate % | Ignore rate %
- Daily cost sparkline (14-day SVG polyline, same pattern as activity sparkline)
- Color: green if cost < $1/day avg, coral if higher

**Step 2: Verify**

Reload admin, verify donut chart renders intents, cost numbers match real classification counts.

**Step 3: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat: admin dashboard — feature adoption + AI cost sections"
```

---

### Task 8: Add Referrals section

**Files:**
- Modify: `src/components/AdminDashboard.jsx`

**Step 1: Add referrals render**

From `feature_stats.referrals`:
- 3 stat cards: Codes Generated | Completed | Conversion Rate %
- Note: currently 0 referrals, so show "No referral data yet" placeholder when all zeros

**Step 2: Commit**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat: admin dashboard — referrals section"
```

---

### Task 9: Hook into App.jsx + admin CSS

**Files:**
- Modify: `src/App.jsx` (add admin screen + URL param detection)
- Modify: `src/styles/app.css` (add admin dashboard styles)

**Step 1: Add admin screen to App.jsx**

At top of file, add import:
```jsx
import AdminDashboard from "./components/AdminDashboard.jsx";
```

In the boot `useEffect`, after `const params = new URLSearchParams(...)`, add admin detection:
```jsx
// Admin dashboard: ?admin=1 after auth
if (params.get("admin") === "1") {
  lsSet("sheli-admin", true);
}
```

In the screen rendering section (after `if (screen === "loading")...`), add before `if (screen === "welcome")`:
```jsx
if (screen === "admin") return <AdminDashboard session={session} onBack={() => setScreen("chat")} />;
```

In the boot async function, after auth resolves and household loads, add:
```jsx
if (lsGet("sheli-admin")) {
  localStorage.removeItem("sheli-admin");
  setScreen("admin");
  return;
}
```

Also add admin access from MenuPanel — add a hidden trigger: triple-tap on version text opens admin for allowlisted users.

**Step 2: Add admin CSS to app.css**

```css
/* ── Admin Dashboard ── */
.admin-dashboard { /* styles */ }
.admin-hero { /* 3-card row */ }
.admin-stat-card { /* big number cards */ }
.admin-sparkline { /* SVG container */ }
.admin-table { /* data tables */ }
.admin-funnel-bar { /* horizontal bar */ }
.admin-donut { /* conic-gradient circle */ }
```

Full-width: `.admin-dashboard` overrides `.app` max-width to `1200px`.

**Step 3: Verify end-to-end**

1. Navigate to `sheli.ai?admin=1`
2. Sign in with Yaron's account
3. Dashboard should render with all 6 sections
4. Try switching periods (7d/30d)
5. Wait 60s, verify auto-refresh updates timestamp
6. Sign in with different account — should NOT see dashboard

**Step 4: Commit**

```bash
git add src/App.jsx src/styles/app.css
git commit -m "feat: wire admin dashboard into app — URL param, screen, CSS"
```

---

### Task 10: Final review + deploy

**Files:**
- All modified files

**Step 1: Review all changes**

- Security: Verify `ADMIN_IDS` matches DB `admin_users`
- Security: Verify RPC functions return `'{}'` for non-admin callers
- UX: All sections render with real data
- Dark theme: Verify admin dashboard respects `[data-theme]`
- Mobile: Dashboard should be scrollable on mobile (it's admin-only, responsive is nice-to-have)

**Step 2: Copy to deploy repo**

```bash
# Copy changed files to ours-app-git
cp src/components/AdminDashboard.jsx ../ours-app-git/src/components/
cp src/App.jsx ../ours-app-git/src/
cp src/styles/app.css ../ours-app-git/src/styles/
```

**Step 3: Commit and push**

```bash
cd ../ours-app-git
git add -A
git commit -m "feat: admin analytics dashboard — live metrics for families, funnel, features, AI costs, referrals"
git push origin main
```

**Step 4: Verify on production**

Navigate to `sheli.ai?admin=1`, sign in, confirm dashboard loads with live data.
