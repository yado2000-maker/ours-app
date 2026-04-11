# Admin Dashboard Design

**Date:** 2026-04-09
**Status:** Approved

## Goal

Live analytics dashboard inside the Sheli web app (`/admin` screen) showing business health across both WhatsApp bot and web app. Helps answer: Are families using it? Is the funnel converting? What features matter? Are we overspending on AI? Are referrals working?

## Security Model (Double-Gated)

### Layer 1: React Admin Guard
- Hardcoded allowlist of Supabase auth user IDs in the component
- If `session.user.id` not in list, render nothing (redirect to chat)
- No URL param secrets, no discoverable route

### Layer 2: SECURITY DEFINER RPC Functions
- All dashboard queries are PostgreSQL functions with `SECURITY DEFINER`
- Each function checks `auth.uid()` against an `admin_users` table
- Returns empty result if caller isn't admin
- No service_role key in browser, no RLS bypass from client

### `admin_users` Table
```sql
CREATE TABLE admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
-- No policies = only service_role can read/write
```

## Dashboard Sections

### Section 0: Hero Banner — "Family Health" (North Star)

Three big numbers, full-width:

| Total Families | Active Families (7d) | Paying Families |
|:-:|:-:|:-:|
| all time count | sent >=1 msg in last 7d | active subscription or free_until > now() |

- **Weekly active families trend line** — each point = households with >=1 message that week, last 8 weeks
- **Cohort retention table** — for each signup week, % still active at 1w/2w/4w (infrastructure for scale)

Data sources:
- `households_v2` (total count, created_at for cohorts)
- `whatsapp_messages` (activity detection — any message from household in period)
- `messages` (web app activity)
- `subscriptions` (paying status: plan != 'free' AND status = 'active', OR free_until > now())

### Section 1: Activity Pulse — "Is it working?"

- **Big number:** Messages today (WhatsApp + web combined)
- **Sparkline:** Messages per day, last 14 days
- **Mini cards:** Active households today | Active this week | Total households | Bot heartbeat (green if last msg < 10min ago)
- **Per-household table:** Name, messages today, last active timestamp, member count

Data sources:
- `whatsapp_messages` (WhatsApp traffic, classification column)
- `messages` (web app chat)
- `households_v2` + `household_members` (metadata)

### Section 2: Onboarding Funnel — "Is the funnel converting?"

- **Horizontal funnel bars** (descending width):
  1. 1:1 conversations started (state = 'welcome')
  2. Demo engaged (state = 'trying')
  3. Waiting to join group (state = 'waiting')
  4. Group activated (state = 'onboarded')
  5. Active user (state = 'active')
- **Conversion %** between each step
- **Stats:** Avg messages to convert, median time welcome→onboarded

Data source: `onboarding_conversations` (state, message_count, created_at, updated_at)

### Section 3: Feature Adoption — "What features do families use?"

- **Intent distribution chart** — pie/donut from classification_data intents:
  `add_shopping`, `add_task`, `add_event`, `complete_task`, `complete_shopping`, `add_reminder`, `question`, `claim_task`, `correct_bot`, `instruct_bot`
- **Per-household adoption table:** Tasks created, shopping items, events, reminders, rotations, corrections
- **Web vs WhatsApp split:** Count of actions by source

Data sources:
- `whatsapp_messages.classification_data` (intent field)
- `tasks`, `shopping_items`, `events` (counts per household)
- `rotations` (active count per household)
- `classification_corrections` (correction count)
- `messages` (web app actions)

### Section 4: AI Cost Control — "Spending"

- **Big number:** Estimated cost this month (USD)
- **Cost formula:** (Haiku calls x $0.0003) + (Sonnet calls x $0.01)
- **Sparkline:** Daily AI spend, last 14 days
- **Mini cards:** Haiku today | Sonnet escalations today | Escalation rate % | Avg tokens/msg
- **Efficiency:** % messages classified as `ignore` by Haiku (higher = cheaper)

Data sources:
- `whatsapp_messages.classification` — count by classification type
- `ai_usage` — token counts, call counts
- Derived: haiku_* prefixed = Haiku call, sonnet_* prefixed = Sonnet call

### Section 5: Referrals — "Growth"

- **Big numbers:** Codes generated | Referrals completed | Conversion rate
- **Per-household table:** Referral code, times shared (approximated), completions, free days earned

Data sources:
- `referrals` (referrer_household_id, status, created_at)
- `households_v2` (referral_code)
- `subscriptions` (free_until for referral rewards)

## Top Bar

- **Date range picker:** Today / 7d / 30d / All time (default: 7d)
- **Last refresh timestamp**
- **Auto-refresh toggle:** 60s interval via `setInterval` (not Realtime — dashboard queries are aggregations, not row-level changes)

## Technical Implementation

### New Screen: "admin"
- Added to `App.jsx` screen state machine
- Route: `?admin=1` URL param detected in boot (before auth check)
- After auth, if admin param present AND user in allowlist → setScreen("admin")
- Component: `src/components/AdminDashboard.jsx`

### RPC Functions (3 PostgreSQL functions)

**`admin_dashboard_overview(p_days INT)`**
Returns JSON with: total_households, active_households, paying_households, messages_today, messages_by_day (array), bot_last_message_at, household_details (array of {name, messages_today, last_active, member_count})

**`admin_funnel_stats()`**
Returns JSON with: funnel_counts (per state), conversion_rates, avg_messages_to_convert, median_onboard_time

**`admin_feature_stats(p_days INT)`**
Returns JSON with: intent_distribution (map), per_household_features (array), ai_cost_estimate, haiku_count, sonnet_count, ignore_rate, referral_stats

All functions: `SECURITY DEFINER`, check `auth.uid() IN (SELECT user_id FROM admin_users)`, return empty JSON if not admin.

### Visualization
- **Sparklines:** Lightweight inline SVG (no chart library needed for 14 data points)
- **Funnel bars:** CSS width percentages
- **Pie chart:** SVG donut (conic-gradient or path-based)
- **Tables:** Simple HTML tables with Sheli design system colors
- **Numbers:** Large font, color-coded (green = good trend, coral = attention)

### No External Dependencies
- No Chart.js, no Recharts, no D3
- All visualizations are hand-rolled SVG/CSS — keeps bundle size zero-impact
- Sparklines: polyline SVG. Donut: conic-gradient. Funnel: div widths.

## File Structure
```
src/components/AdminDashboard.jsx    — Main dashboard component
src/components/admin/                — Sub-components (optional, split if >500 lines)
  HeroBanner.jsx
  ActivityPulse.jsx
  OnboardingFunnel.jsx
  FeatureAdoption.jsx
  CostControl.jsx
  ReferralStats.jsx
```

## Not Included (Future)
- Real-time Supabase subscriptions (overkill for admin, 60s polling is fine)
- Export to CSV
- Multi-admin role management
- Historical cohort analysis beyond 4 weeks
