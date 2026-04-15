# WhatsApp Visual Views Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.
>
> **Design doc:** [2026-04-15-whatsapp-visual-views-design.md](2026-04-15-whatsapp-visual-views-design.md) — read first for the "why."

**Goal:** Ship four WhatsApp-native data views (השבוע, שבוע שעבר, קניות, היום) + a Sunday 07:30 push for השבוע, so users see structured household data inside WhatsApp without opening sheli.ai.

**Architecture:** Haiku classifier routes new `show_view` / `view_feedback` / `opt_out_digest` intents. Deterministic text formatters in Supabase Edge Function render text for tiers 0-7 items. Vercel route `/api/weekly-image` (via `@vercel/og`) renders portrait PNG for tier 8+. Bot fetches PNG as base64 and sends via Whapi `/messages/image`. Sunday push driven by pg_cron + `weekly_digest_queue`. View feedback goes through three-path Sonnet escalation (re-render / clarify / flag-to-founder).

**Tech Stack:** Supabase Edge Functions (Deno/TypeScript), Vercel (Next.js-style API route, Edge runtime), `@vercel/og` (Satori), pg_cron, Haiku 4.5 + Sonnet 4.5, Whapi.Cloud `/messages/image`, React (admin dashboard).

**Conventions in this codebase:**
- The deployed Edge Function is `supabase/functions/whatsapp-webhook/index.inlined.ts` — the modular `_shared/*.ts` files are dev reference. Every task that touches a `_shared/*.ts` file must regenerate the inlined file afterward.
- Field naming: DB snake_case, JS camelCase. Use `toDb`/`fromDb` mappers in `src/lib/supabase.js` at the boundary.
- Commits: single-folder workflow (`ours-app/`). Edit → commit → push → Vercel auto-deploys.
- No `sed -i` on source files (CLAUDE.md: corrupts encoding on Windows Git Bash).

---

## Phase 1 — Text foundation (tasks 1–18)

**Outcome of phase:** All four views respond on-demand in text form. Opt-out works. Feedback handler routes correctly. No Sunday push yet, no image yet.

---

### Task 1: Migration — add `households_v2.weekly_digest_enabled`

**Files:**
- Migration via `mcp__f5337598__apply_migration` tool (no physical file written by us; Supabase records it in `supabase_migrations.schema_migrations`)

**Step 1: Write the migration SQL**

```sql
ALTER TABLE households_v2
  ADD COLUMN IF NOT EXISTS weekly_digest_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN households_v2.weekly_digest_enabled IS
  'When TRUE, household receives Sunday 07:30 השבוע digest. Toggled by opt_out_digest / opt_in_digest intents.';
```

**Step 2: Apply it**

Invoke `mcp__f5337598__apply_migration`:
- `project_id`: `wzwwtghtnkapdwlgnrxr`
- `name`: `add_weekly_digest_enabled_to_households_v2`
- `query`: (SQL above)

**Step 3: Verify schema**

Invoke `mcp__f5337598__list_tables` for schema `public`, verify `households_v2.weekly_digest_enabled` appears with `BOOLEAN DEFAULT true`.

Also verify existing rows got `true`:
```sql
SELECT COUNT(*) FILTER (WHERE weekly_digest_enabled = TRUE) AS enabled,
       COUNT(*) AS total
FROM households_v2;
```
Expected: `enabled = total`.

**Step 4: Commit**

No code file changed; migration is recorded in DB. Move on.

---

### Task 2: Migration — add `whatsapp_config.last_view_*` columns

**Files:**
- Migration via `mcp__f5337598__apply_migration`

**Step 1: Write migration SQL**

```sql
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS last_view_type TEXT,              -- 'weekly' | 'retrospective' | 'shopping' | 'today'
  ADD COLUMN IF NOT EXISTS last_view_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_view_content_hash TEXT,      -- md5 of rendered content for dedup/debug
  ADD COLUMN IF NOT EXISTS last_view_item_count INT,
  ADD COLUMN IF NOT EXISTS last_view_scope TEXT;             -- 'household' | 'personal'

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_last_view_sent
  ON whatsapp_config(last_view_sent_at DESC)
  WHERE last_view_sent_at IS NOT NULL;
```

**Step 2: Apply**

`mcp__f5337598__apply_migration` with name `add_last_view_columns_to_whatsapp_config`.

**Step 3: Verify**

`mcp__f5337598__list_tables` — confirm all five columns on `whatsapp_config`, index present.

---

### Task 3: Migration — create `view_feedback_review` table

**Files:**
- Migration via `mcp__f5337598__apply_migration`

**Step 1: Write migration SQL**

```sql
CREATE TABLE IF NOT EXISTS view_feedback_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  sender_phone TEXT NOT NULL,
  user_message TEXT NOT NULL,
  last_view_type TEXT,
  last_view_sent_at TIMESTAMPTZ,
  last_view_content_hash TEXT,
  last_view_item_count INT,
  last_view_scope TEXT,
  sonnet_reason TEXT,                      -- Sonnet's free-text explanation
  severity TEXT NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high'
  reviewed_at TIMESTAMPTZ,                 -- when Yaron first opened it
  resolved_at TIMESTAMPTZ,                 -- when Yaron marked resolved
  notes TEXT,                              -- Yaron's notes on resolution
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_view_feedback_review_unresolved
  ON view_feedback_review(created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX idx_view_feedback_review_severity_created
  ON view_feedback_review(severity, created_at DESC);

-- RLS: service-role only (no policies)
ALTER TABLE view_feedback_review ENABLE ROW LEVEL SECURITY;
```

**Step 2: Apply**

`name`: `create_view_feedback_review_table`.

**Step 3: Verify**

`mcp__f5337598__list_tables` — confirm table, both indexes, RLS enabled, no policies.

---

### Task 4: Create `view-data.ts` — source-abstraction seam

**Files:**
- Create: `supabase/functions/_shared/view-data.ts`

**Step 1: Write failing test stub first**

Add to `tests/test_webhook.py` a new test stub (we'll fill it in Task 10):
```python
def test_fetch_all_events_returns_events_rows():
    """fetchAllEvents wraps events table and is the source-abstraction seam."""
    # Placeholder — real test added in Task 10 once classifier + routing exists
    pass
```

Skip this runtime test for now — it's a placeholder marking intent.

**Step 2: Write the module**

```typescript
// supabase/functions/_shared/view-data.ts
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type EventVisibility = "public" | "busy" | "private";

export interface Event {
  id: string;
  household_id: string;
  title: string | null;
  scheduled_for: string;      // ISO
  duration_minutes: number | null;
  assigned_to: string | null;
  source: "sheli" | "gcal";   // v1: always "sheli"
  visibility: EventVisibility; // v1: always "public"
}

/**
 * Source-abstraction seam (see design doc "Forward compatibility"):
 * v1: wraps events table only.
 * Phase 3: will union with gcal_events and dedup by external_id.
 */
export async function fetchAllEvents(
  supabase: SupabaseClient,
  householdId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<Event[]> {
  const { data, error } = await supabase
    .from("events")
    .select("id, household_id, title, scheduled_for, duration_minutes, assigned_to")
    .eq("household_id", householdId)
    .gte("scheduled_for", windowStart.toISOString())
    .lte("scheduled_for", windowEnd.toISOString())
    .order("scheduled_for", { ascending: true });

  if (error) throw error;

  return (data || []).map((row) => ({
    ...row,
    source: "sheli" as const,
    visibility: "public" as const,
  }));
}
```

**Step 3: Verify file compiles**

Run: `deno check supabase/functions/_shared/view-data.ts`
Expected: no errors.

**Step 4: Commit**

```bash
git add supabase/functions/_shared/view-data.ts
git commit -m "feat(views): add fetchAllEvents source-abstraction seam"
```

---

### Task 5: Add `fetchWeeklyView` to `view-data.ts`

**Files:**
- Modify: `supabase/functions/_shared/view-data.ts`

**Step 1: Write the time-horizon helper** (tested in Task 10 via integration test)

Add to `view-data.ts`:

```typescript
const WEEK_FLIP_SATURDAY_HOUR = 17;
const IL_TZ = "Asia/Jerusalem";

/**
 * Compute the השבוע time horizon per design doc "Time horizon" table.
 * Returns { windowStart, windowEnd, horizonKind }.
 *   horizonKind: "this_week" | "this_week_plus_peek" | "next_week"
 */
export function computeWeeklyHorizon(now: Date): {
  windowStart: Date;
  windowEnd: Date;
  horizonKind: "this_week" | "this_week_plus_peek" | "next_week";
  todayDayIndex: number; // 0=Sun, 6=Sat, in IL time
} {
  const ilNow = new Date(now.toLocaleString("en-US", { timeZone: IL_TZ }));
  const dow = ilNow.getDay(); // 0=Sun..6=Sat
  const hour = ilNow.getHours();

  // Today in IL time at 00:00
  const todayStart = new Date(ilNow);
  todayStart.setHours(0, 0, 0, 0);

  // Saturday 17:00+ → pivot to NEXT week fully
  if (dow === 6 && hour >= WEEK_FLIP_SATURDAY_HOUR) {
    const nextSunday = new Date(todayStart);
    nextSunday.setDate(nextSunday.getDate() + 1); // Sat → Sun
    const nextSaturday = new Date(nextSunday);
    nextSaturday.setDate(nextSaturday.getDate() + 6);
    nextSaturday.setHours(23, 59, 59, 999);
    return { windowStart: nextSunday, windowEnd: nextSaturday, horizonKind: "next_week", todayDayIndex: dow };
  }

  // Friday (any hour) OR Saturday before 17 → this-week remainder + peek next Sun-Tue
  if (dow === 5 || (dow === 6 && hour < WEEK_FLIP_SATURDAY_HOUR)) {
    const satEnd = new Date(todayStart);
    satEnd.setDate(satEnd.getDate() + (dow === 5 ? 1 : 0)); // Fri→+1, Sat→0
    const peekEnd = new Date(satEnd);
    peekEnd.setDate(peekEnd.getDate() + 3); // +Sun, +Mon, +Tue
    peekEnd.setHours(23, 59, 59, 999);
    return { windowStart: todayStart, windowEnd: peekEnd, horizonKind: "this_week_plus_peek", todayDayIndex: dow };
  }

  // Sun–Thu any hour → today through this Sat 23:59
  const daysUntilSat = 6 - dow;
  const satEnd = new Date(todayStart);
  satEnd.setDate(satEnd.getDate() + daysUntilSat);
  satEnd.setHours(23, 59, 59, 999);
  return { windowStart: todayStart, windowEnd: satEnd, horizonKind: "this_week", todayDayIndex: dow };
}
```

**Step 2: Write fetchWeeklyView using the horizon + fetchAllEvents**

```typescript
export interface WeeklyDay {
  date: string;           // YYYY-MM-DD
  dayIndex: number;       // 0=Sun..6=Sat
  isToday: boolean;
  events: Event[];
  datedTasks: Task[];
  rotation: RotationTurn | null;
}

export interface Task {
  id: string;
  title: string;
  assigned_to: string | null;
  due_at: string | null;
  done: boolean;
}

export interface RotationTurn {
  rotation_id: string;
  title: string;       // e.g., "כביסה"
  icon: string;        // "🧺"
  holder: string;      // display name
}

export interface WeeklyView {
  days: WeeklyDay[];
  undatedTasks: Task[];
  meta: {
    totalItems: number;  // events + dated tasks + undated tasks (no rotations)
    horizonKind: "this_week" | "this_week_plus_peek" | "next_week";
  };
}

export async function fetchWeeklyView(
  supabase: SupabaseClient,
  householdId: string,
  filterScope: "personal" | "household" = "household",
  filterPerson: string | null = null,
  now: Date = new Date()
): Promise<WeeklyView> {
  const { windowStart, windowEnd, horizonKind, todayDayIndex } = computeWeeklyHorizon(now);

  // Fetch events (via abstraction seam) and tasks in parallel
  const [events, tasksResult] = await Promise.all([
    fetchAllEvents(supabase, householdId, windowStart, windowEnd),
    supabase
      .from("tasks")
      .select("id, title, assigned_to, due_at, done")
      .eq("household_id", householdId)
      .eq("done", false)
      .order("due_at", { ascending: true, nullsFirst: false }),
  ]);

  if (tasksResult.error) throw tasksResult.error;
  const allTasks: Task[] = tasksResult.data || [];

  // Personal filter: keep only rows assigned to filterPerson (or sender when filterPerson is null)
  const wantsPersonal = filterScope === "personal";
  const personKey = filterPerson;  // caller passes sender's display_name when wantsPersonal
  const scopedEvents = wantsPersonal && personKey
    ? events.filter((e) => e.assigned_to === personKey)
    : events;
  const scopedDated = wantsPersonal && personKey
    ? allTasks.filter((t) => t.due_at && t.assigned_to === personKey)
    : allTasks.filter((t) => t.due_at);
  const scopedUndated = wantsPersonal && personKey
    ? allTasks.filter((t) => !t.due_at && t.assigned_to === personKey)
    // In 1:1 personal view we ALSO include unassigned household tasks (capped at 5, see design)
    : allTasks.filter((t) => !t.due_at);

  // Build day buckets
  const days: WeeklyDay[] = [];
  const cursor = new Date(windowStart);
  while (cursor <= windowEnd) {
    const yyyymmdd = cursor.toISOString().slice(0, 10);
    const dayEvents = scopedEvents.filter((e) => e.scheduled_for.startsWith(yyyymmdd));
    const dayTasks = scopedDated.filter((t) => t.due_at && t.due_at.startsWith(yyyymmdd));

    if (dayEvents.length > 0 || dayTasks.length > 0) {
      days.push({
        date: yyyymmdd,
        dayIndex: cursor.getDay(),
        isToday: cursor.getDay() === todayDayIndex && cursor.toDateString() === new Date().toDateString(),
        events: dayEvents,
        datedTasks: dayTasks,
        rotation: null, // populated in Task 6
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    days,
    undatedTasks: scopedUndated,
    meta: {
      totalItems: scopedEvents.length + scopedDated.length + scopedUndated.length,
      horizonKind,
    },
  };
}
```

**Step 3: Type-check**

Run: `deno check supabase/functions/_shared/view-data.ts`
Expected: no errors.

**Step 4: Commit**

```bash
git add supabase/functions/_shared/view-data.ts
git commit -m "feat(views): add fetchWeeklyView with Israeli-week horizon logic"
```

---

### Task 6: Add rotation fetch to weekly view

**Files:**
- Modify: `supabase/functions/_shared/view-data.ts`

**Step 1: Write the rotation fetch helper**

In `view-data.ts`, after the Task 5 additions, insert:

```typescript
async function fetchRotationsForWindow(
  supabase: SupabaseClient,
  householdId: string,
  days: WeeklyDay[]
): Promise<void> {
  const { data: rotations, error } = await supabase
    .from("rotations")
    .select("id, title, icon, type, members, current_index")
    .eq("household_id", householdId)
    .eq("active", true);

  if (error) throw error;
  if (!rotations || rotations.length === 0) return;

  // For each day, compute whose turn it is.
  // `order` type rotations: advance by day.
  // `duty` type: weekly (same holder all week). Design: assume both advance daily; tune later.
  for (const day of days) {
    for (const rot of rotations) {
      const members: string[] = Array.isArray(rot.members)
        ? rot.members
        : JSON.parse(rot.members);
      if (members.length === 0) continue;
      // Deterministic: index = (current_index + days-since-today) mod members.length
      // For v1 simplicity, show current_index holder on every day (duty-style).
      // TODO: refine per rotation.type in later pass.
      day.rotation = {
        rotation_id: rot.id,
        title: rot.title,
        icon: rot.icon || "🔸",
        holder: members[rot.current_index] || members[0],
      };
      break; // one rotation line per day for now
    }
  }
}
```

**Step 2: Call it at the end of `fetchWeeklyView`**

Before the return in `fetchWeeklyView`, add:
```typescript
  await fetchRotationsForWindow(supabase, householdId, days);
```

**Step 3: Type-check**

Run: `deno check supabase/functions/_shared/view-data.ts`

**Step 4: Commit**

```bash
git add supabase/functions/_shared/view-data.ts
git commit -m "feat(views): include rotations per day in weekly view"
```

---

### Task 7: Add `fetchRetrospectiveView`, `fetchShoppingView`, `fetchTodayView`

**Files:**
- Modify: `supabase/functions/_shared/view-data.ts`

**Step 1: Append to `view-data.ts`**

```typescript
export interface RetrospectiveView {
  completedTasks: Array<{ id: string; title: string; done_by: string | null; done_at: string }>;
  purchasedShopping: Array<{ id: string; name: string; got_by: string | null; got_at: string }>;
  windowStart: Date;
  windowEnd: Date;
}

export async function fetchRetrospectiveView(
  supabase: SupabaseClient,
  householdId: string,
  filterScope: "personal" | "household" = "household",
  filterPerson: string | null = null,
  now: Date = new Date()
): Promise<RetrospectiveView> {
  const windowEnd = now;
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - 7);

  const [tasksRes, shopRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, done_by, done_at")
      .eq("household_id", householdId)
      .eq("done", true)
      .gte("done_at", windowStart.toISOString())
      .lte("done_at", windowEnd.toISOString())
      .order("done_at", { ascending: false }),
    supabase
      .from("shopping_items")
      .select("id, name, got_by, got_at")
      .eq("household_id", householdId)
      .eq("got", true)
      .gte("got_at", windowStart.toISOString())
      .lte("got_at", windowEnd.toISOString())
      .order("got_at", { ascending: false }),
  ]);

  if (tasksRes.error) throw tasksRes.error;
  if (shopRes.error) throw shopRes.error;

  let tasks = tasksRes.data || [];
  let shop = shopRes.data || [];
  if (filterScope === "personal" && filterPerson) {
    tasks = tasks.filter((t) => t.done_by === filterPerson);
    shop = shop.filter((s) => s.got_by === filterPerson);
  }

  return { completedTasks: tasks, purchasedShopping: shop, windowStart, windowEnd };
}

export interface ShoppingView {
  byCategory: Array<{ category: string; items: Array<{ id: string; name: string; qty: number | null }> }>;
  total: number;
}

export async function fetchShoppingView(
  supabase: SupabaseClient,
  householdId: string
): Promise<ShoppingView> {
  const { data, error } = await supabase
    .from("shopping_items")
    .select("id, name, qty, category")
    .eq("household_id", householdId)
    .eq("got", false)
    .order("category", { ascending: true });

  if (error) throw error;

  const byCat = new Map<string, Array<{ id: string; name: string; qty: number | null }>>();
  for (const row of data || []) {
    const cat = row.category || "אחר";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push({ id: row.id, name: row.name, qty: row.qty });
  }

  return {
    byCategory: Array.from(byCat, ([category, items]) => ({ category, items })),
    total: (data || []).length,
  };
}

export interface TodayView {
  events: Event[];
  tasks: Task[];
  rotationToday: RotationTurn | null;
}

export async function fetchTodayView(
  supabase: SupabaseClient,
  householdId: string,
  filterScope: "personal" | "household" = "household",
  filterPerson: string | null = null,
  now: Date = new Date()
): Promise<TodayView> {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setHours(23, 59, 59, 999);

  const [events, tasksRes] = await Promise.all([
    fetchAllEvents(supabase, householdId, todayStart, todayEnd),
    supabase
      .from("tasks")
      .select("id, title, assigned_to, due_at, done")
      .eq("household_id", householdId)
      .eq("done", false)
      .or(`due_at.gte.${todayStart.toISOString()},due_at.is.null`)
      .lte("due_at", todayEnd.toISOString()),
  ]);

  if (tasksRes.error) throw tasksRes.error;
  let tasks = (tasksRes.data || []).filter((t) => t.due_at);
  let filteredEvents = events;
  if (filterScope === "personal" && filterPerson) {
    tasks = tasks.filter((t) => t.assigned_to === filterPerson);
    filteredEvents = events.filter((e) => e.assigned_to === filterPerson);
  }

  // Today's rotation holder — reuse rotation fetch, pick the one for today
  const dummyDays: WeeklyDay[] = [{ date: todayStart.toISOString().slice(0, 10), dayIndex: todayStart.getDay(), isToday: true, events: [], datedTasks: [], rotation: null }];
  await fetchRotationsForWindow(supabase, householdId, dummyDays);

  return { events: filteredEvents, tasks, rotationToday: dummyDays[0].rotation };
}
```

**Step 2: Type-check**

Run: `deno check supabase/functions/_shared/view-data.ts`

**Step 3: Commit**

```bash
git add supabase/functions/_shared/view-data.ts
git commit -m "feat(views): add retrospective, shopping, today fetchers"
```

---

### Task 8: Create `view-formatters.ts` — `formatWeeklyText`

**Files:**
- Create: `supabase/functions/_shared/view-formatters.ts`

**Step 1: Write the weekly text formatter**

```typescript
// supabase/functions/_shared/view-formatters.ts
import type { WeeklyView, RetrospectiveView, ShoppingView, TodayView, Event, Task, RotationTurn, EventVisibility } from "./view-data.ts";

const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const ITEMS_PER_DAY_CAP = 7;
const UNDATED_CAP = 5;

function truncate(s: string, n = 20): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmtTime(iso: string): string | null {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  if (h === 0 && m === 0) return null;          // midnight = untimed
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function eventLine(e: Event): string {
  // Respect visibility (forward-compat: busy events omit title in Phase 3)
  const time = fmtTime(e.scheduled_for);
  const who = e.assigned_to ? ` — ${e.assigned_to}` : "";
  if (e.visibility === "busy") {
    return `${time || ""} עסוק${who}`.trim();
  }
  const title = e.title ? truncate(e.title) : "(ללא כותרת)";
  return time ? `${time} ${title}${who}` : `${title}${who}`;
}

function taskLine(t: Task): string {
  const who = t.assigned_to ? ` — ${t.assigned_to}` : "";
  return `${truncate(t.title)}${who}`;
}

function rotationLine(r: RotationTurn, isToday: boolean): string {
  const arrow = isToday ? "   ← היום" : "";
  return `${r.icon} ${r.title} — ${r.holder}${arrow}`;
}

export function formatWeeklyText(view: WeeklyView): string {
  const lines: string[] = ["📅 השבוע", ""];

  for (const day of view.days) {
    const date = new Date(day.date);
    const dayHe = HE_DAYS[day.dayIndex];
    const dm = `${date.getDate()}/${date.getMonth() + 1}`;
    const header = day.isToday ? `${dayHe} ${dm}   ← היום` : `${dayHe} ${dm}`;
    lines.push(header);

    const dayItems: string[] = [];
    // Order: rotations first, then events (time-ordered), then dated tasks
    if (day.rotation) dayItems.push(`  ${rotationLine(day.rotation, day.isToday)}`);
    for (const e of day.events) dayItems.push(`  ${eventLine(e)}`);
    for (const t of day.datedTasks) dayItems.push(`  ${taskLine(t)}`);

    if (dayItems.length > ITEMS_PER_DAY_CAP) {
      lines.push(...dayItems.slice(0, ITEMS_PER_DAY_CAP));
      lines.push(`  ועוד ${dayItems.length - ITEMS_PER_DAY_CAP} ב${dayHe}`);
    } else {
      lines.push(...dayItems);
    }
    lines.push("");
  }

  if (view.undatedTasks.length > 0) {
    lines.push("📌 ללא תאריך:");
    const capped = view.undatedTasks.slice(0, UNDATED_CAP);
    for (const t of capped) lines.push(`  • ${taskLine(t)}`);
    if (view.undatedTasks.length > UNDATED_CAP) {
      lines.push(`  ועוד ${view.undatedTasks.length - UNDATED_CAP}`);
    }
  }

  return lines.join("\n").trim();
}

/**
 * Tier 0-2 inline reply — one-liner, no structured view.
 */
export function formatWeeklySparse(view: WeeklyView): string {
  const items: string[] = [];
  for (const day of view.days) {
    for (const e of day.events) items.push(`${HE_DAYS[day.dayIndex]} ${e.title || ""}`.trim());
    for (const t of day.datedTasks) items.push(`${HE_DAYS[day.dayIndex]} ${t.title}`);
  }
  for (const t of view.undatedTasks) items.push(t.title);
  if (items.length === 0) return "שבוע ריק — תרצו להוסיף משהו? 😌";
  if (items.length === 1) return `שבוע רגוע — רק ${items[0]} 😌`;
  return `שבוע רגוע — ${items.slice(0, 2).join(" ו")} 😌`;
}
```

**Step 2: Type-check**

Run: `deno check supabase/functions/_shared/view-formatters.ts`

**Step 3: Commit**

```bash
git add supabase/functions/_shared/view-formatters.ts
git commit -m "feat(views): add formatWeeklyText and formatWeeklySparse"
```

---

### Task 9: Add remaining text formatters (retrospective, shopping, today)

**Files:**
- Modify: `supabase/functions/_shared/view-formatters.ts`

**Step 1: Append to `view-formatters.ts`**

```typescript
export function formatRetrospectiveText(view: RetrospectiveView): string {
  if (view.completedTasks.length === 0 && view.purchasedShopping.length === 0) {
    return "אין עדיין מה לסכם 🙂";
  }

  const lines: string[] = ["📖 שבוע שעבר", ""];

  if (view.completedTasks.length > 0) {
    lines.push(`✅ בוצעו (${view.completedTasks.length}):`);
    const byPerson = new Map<string, string[]>();
    for (const t of view.completedTasks) {
      const who = t.done_by || "לא משובץ";
      if (!byPerson.has(who)) byPerson.set(who, []);
      byPerson.get(who)!.push(truncate(t.title));
    }
    for (const [who, items] of byPerson) {
      lines.push(`  ${who}: ${items.join(", ")}`);
    }
    lines.push("");
  }

  if (view.purchasedShopping.length > 0) {
    lines.push(`🛒 נקנו (${view.purchasedShopping.length}):`);
    for (const s of view.purchasedShopping.slice(0, 10)) {
      const who = s.got_by ? ` — ${s.got_by}` : "";
      lines.push(`  • ${truncate(s.name)}${who}`);
    }
    if (view.purchasedShopping.length > 10) {
      lines.push(`  ועוד ${view.purchasedShopping.length - 10}`);
    }
  }

  return lines.join("\n").trim();
}

export function formatShoppingText(view: ShoppingView): string {
  if (view.total === 0) return "רשימת הקניות ריקה 🎉";

  const lines: string[] = [`🛒 קניות (${view.total})`, ""];
  for (const { category, items } of view.byCategory) {
    lines.push(`📦 ${category}`);
    for (const it of items) {
      const qty = it.qty && it.qty > 1 ? ` ×${it.qty}` : "";
      lines.push(`  • ${truncate(it.name, 30)}${qty}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function formatTodayText(view: TodayView): string {
  const parts: string[] = [];
  if (view.rotationToday) {
    parts.push(`${view.rotationToday.icon} ${view.rotationToday.title}: ${view.rotationToday.holder}`);
  }
  for (const e of view.events) parts.push(eventLine(e));
  for (const t of view.tasks) parts.push(taskLine(t));

  if (parts.length === 0) return "היום שקט 🙂";
  return `📅 היום\n\n${parts.map((p) => `  ${p}`).join("\n")}`.trim();
}
```

**Step 2: Type-check**

Run: `deno check supabase/functions/_shared/view-formatters.ts`

**Step 3: Commit**

```bash
git add supabase/functions/_shared/view-formatters.ts
git commit -m "feat(views): add retrospective, shopping, today text formatters"
```

---

### Task 10: Extend Haiku classifier with `show_view` intent

**Files:**
- Modify: `supabase/functions/_shared/haiku-classifier.ts`

**Step 1: Add the intent + entities to the prompt**

Open `supabase/functions/_shared/haiku-classifier.ts`. Find the intents list (likely a large string constant listing all supported intents). Add to it:

- `show_view` — user wants to see a structured view of household data
- `view_feedback` — feedback or complaint about a view we just sent
- `opt_out_digest` — user wants to stop the Sunday weekly digest
- `opt_in_digest` — user wants to restart the Sunday weekly digest

In the prompt's entities-per-intent section, add for `show_view`:
```
show_view entities:
- view_type: "weekly" | "retrospective" | "shopping" | "today"
- filter_scope: "personal" | "household" | null  (null = use context-aware default)
- filter_person: string | null  (member display name when user named one)
```

**Step 2: Add seed examples**

In the examples section of the prompt, add (exact Hebrew — double-check punctuation):

For `show_view: weekly`:
- "השבוע" → `{ intent: "show_view", view_type: "weekly", filter_scope: null, filter_person: null }`
- "סיכום השבוע" → same
- "איך נראה השבוע" → same
- "מה יש לנו השבוע" → `{ intent: "show_view", view_type: "weekly", filter_scope: "household", filter_person: null }`
- "מה קורה השבוע" → same as first
- "אפשר לראות את הלו"ז" → same as first
- "איפה רשימת המשימות" → same as first
- "תני לי את רשימת התזכורות" → same as first
- "מה לי השבוע" → `{ intent: "show_view", view_type: "weekly", filter_scope: "personal", filter_person: null }`
- "השבוע שלי" → same
- "מה לאמא השבוע" → `{ intent: "show_view", view_type: "weekly", filter_scope: "personal", filter_person: "אמא" }`

For `show_view: retrospective`:
- "מה עשינו השבוע" → `{ intent: "show_view", view_type: "retrospective", filter_scope: null, filter_person: null }`
- "מי עשה מה" → same
- "השבוע שעבר" → same

For `show_view: shopping`:
- "קניות" / "רשימת קניות" / "מה בקניות" → `{ intent: "show_view", view_type: "shopping" }`

For `show_view: today`:
- "היום" / "מה היום" / "what's today" → `{ intent: "show_view", view_type: "today", filter_scope: null, filter_person: null }`

For `view_feedback`:
- "התקציר לא נכון" / "חסר לי משהו" / "למה אין את X" / "רוצה לראות גם Y" / "זה מבלבל" → `{ intent: "view_feedback" }`

For `opt_out_digest`:
- "בלי תקציר שבועי" / "לא רוצים תקציר" / "stop weekly digest" → `{ intent: "opt_out_digest" }`

For `opt_in_digest`:
- "תחזרו לתקציר שבועי" / "start weekly digest" → `{ intent: "opt_in_digest" }`

**Step 3: Type-check**

Run: `deno check supabase/functions/_shared/haiku-classifier.ts`

**Step 4: Commit**

```bash
git add supabase/functions/_shared/haiku-classifier.ts
git commit -m "feat(classifier): add show_view, view_feedback, opt_out_digest intents"
```

---

### Task 11: Regenerate `index.inlined.ts` from modular sources

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Regenerate the inlined file**

CLAUDE.md: "Always edit `index.inlined.ts` for production changes. The modular `_shared/` files are dev reference. Must regenerate inlined file after any modular change."

Look for an existing inliner script in the repo (likely `scripts/inline-shared.sh` or similar). If one doesn't exist, inline manually: the deployed file `supabase/functions/whatsapp-webhook/index.inlined.ts` has the content of the modular files pasted in.

Sections to update in `index.inlined.ts`:
- Copy the new Haiku prompt additions (intent list, entity schema, seed examples) from `haiku-classifier.ts`.
- Paste `view-data.ts` content into the inlined file's data-helpers section.
- Paste `view-formatters.ts` content into the inlined file's formatters section.

**Step 2: Type-check the inlined file**

Run: `deno check supabase/functions/whatsapp-webhook/index.inlined.ts`
Expected: no errors.

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "chore(bot): regenerate inlined file with view helpers and classifier changes"
```

---

### Task 12: Wire `show_view` routing in `index.inlined.ts`

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Add the router branch**

Find the classifier-intent dispatcher (search for `case "question":` in the file — around line 879 per earlier exploration). Add BEFORE that case:

```typescript
case "show_view": {
  const viewType = classification.entities.view_type as "weekly" | "retrospective" | "shopping" | "today";
  const rawScope = classification.entities.filter_scope as "personal" | "household" | null;
  const rawPerson = classification.entities.filter_person as string | null;

  // Context-aware default: 1:1 → personal (sender), group → household
  const isDirect = message.chatId.endsWith("@s.whatsapp.net");
  const resolvedScope: "personal" | "household" = rawScope ?? (isDirect ? "personal" : "household");
  const resolvedPerson: string | null = rawPerson ?? (resolvedScope === "personal" ? message.senderName : null);

  let replyText: string;
  let itemCount = 0;
  const hash = crypto.randomUUID();  // content hash simplified for v1

  if (viewType === "weekly") {
    const weekly = await fetchWeeklyView(supabase, householdId, resolvedScope, resolvedPerson);
    itemCount = weekly.meta.totalItems;
    replyText = itemCount <= 2 ? formatWeeklySparse(weekly) : formatWeeklyText(weekly);
    // Tier 8+ image rendering handled in Phase 3; for Phase 1 we always send text
  } else if (viewType === "retrospective") {
    const retro = await fetchRetrospectiveView(supabase, householdId, resolvedScope, resolvedPerson);
    itemCount = retro.completedTasks.length + retro.purchasedShopping.length;
    replyText = formatRetrospectiveText(retro);
  } else if (viewType === "shopping") {
    const shop = await fetchShoppingView(supabase, householdId);
    itemCount = shop.total;
    replyText = formatShoppingText(shop);
  } else {
    // today
    const today = await fetchTodayView(supabase, householdId, resolvedScope, resolvedPerson);
    itemCount = today.events.length + today.tasks.length;
    replyText = formatTodayText(today);
  }

  await provider.sendMessage({ to: message.chatId, text: replyText });

  // Record for view_feedback context (Task 13 uses this)
  await supabase
    .from("whatsapp_config")
    .update({
      last_view_type: viewType,
      last_view_sent_at: new Date().toISOString(),
      last_view_content_hash: hash,
      last_view_item_count: itemCount,
      last_view_scope: resolvedScope,
    })
    .eq(isDirect ? "direct_phone" : "group_id", message.chatId);

  await logMessage(message, "show_view", householdId, classification);
  return;
}
```

**Step 2: Type-check**

Run: `deno check supabase/functions/whatsapp-webhook/index.inlined.ts`
Expected: no errors. Resolve any missing imports (the `fetch*` functions are now inlined).

**Step 3: Deploy to Supabase**

Per CLAUDE.md: Open file in Cursor/VS Code → Ctrl+A, Ctrl+C → Supabase Dashboard → Code tab → paste → Deploy. Verify JWT = OFF.

**Step 4: Smoke test in production (staging household)**

Send message "השבוע" to the bot from the founder's group.
Expected: structured text reply with the weekly view, or the sparse one-liner if items < 3.

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): route show_view intent to view formatters (Phase 1: text only)"
```

---

### Task 13: Wire `view_feedback` routing with three-path Sonnet escalation

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`
- Modify: `supabase/functions/_shared/reply-generator.ts`

**Step 1: Extend Sonnet prompt for view_feedback context**

In the Sonnet reply-generator prompt builder, add a special branch: when `classification.intent === "view_feedback"`, load `whatsapp_config.last_view_*` and inject:

```typescript
if (classification.intent === "view_feedback" && ctx.lastView) {
  const ageMin = Math.floor((Date.now() - new Date(ctx.lastView.sent_at).getTime()) / 60000);
  stateContext += `\n\nYOU SENT A VIEW RECENTLY:
- Type: ${ctx.lastView.type}
- Sent: ${ageMin} minutes ago
- Item count: ${ctx.lastView.item_count}
- Scope: ${ctx.lastView.scope}

USER IS GIVING YOU FEEDBACK ON THAT VIEW. Pick ONE of three paths:

(a) RE-RENDER — if you clearly understand a tweak they want.
    Emit at end: <!--RERENDER:{"view_type":"weekly","filter_scope":"personal","filter_person":"name or null"}-->
    Reply: short warm confirmation ("רגע, מיד...").

(b) CLARIFY — if the request is ambiguous but plausibly a small tweak.
    Ask ONE short clarifying question. No tail block.

(c) ESCALATE TO FOUNDER — if genuinely unclear, or the ask is beyond a re-render (bug, missing feature, data looks wrong, angry tone).
    Reply warmly: "בדיוק עכשיו אני לא בטוחה — אני אבדוק עם ירון ואחזור אליכם 🙏"
    Emit at end: <!--FLAG_FOR_FOUNDER:{"reason":"<one-line English summary>","severity":"low|medium|high"}-->
`;
}
```

**Step 2: Add the router branch in `index.inlined.ts`**

After the `show_view` case:

```typescript
case "view_feedback": {
  const isDirect = message.chatId.endsWith("@s.whatsapp.net");
  const { data: config } = await supabase
    .from("whatsapp_config")
    .select("last_view_type, last_view_sent_at, last_view_content_hash, last_view_item_count, last_view_scope")
    .eq(isDirect ? "direct_phone" : "group_id", message.chatId)
    .single();

  if (!config?.last_view_type) {
    await provider.sendMessage({
      to: message.chatId,
      text: "לא זוכרת איזה תצוגה הייתה אחרונה — תרצו לראות את השבוע?",
    });
    await logMessage(message, "view_feedback_no_context", householdId, classification);
    return;
  }

  // Call Sonnet with view_feedback context (reply-generator handles this path)
  const sonnetResult = await generateSonnetReply({
    classification,
    message,
    householdId,
    ctx: { ...existingCtx, lastView: {
      type: config.last_view_type,
      sent_at: config.last_view_sent_at,
      item_count: config.last_view_item_count,
      scope: config.last_view_scope,
    } },
  });

  // Parse tail blocks
  const rerenderMatch = sonnetResult.text.match(/<!--RERENDER:(\{.*?\})-->/);
  const flagMatch = sonnetResult.text.match(/<!--FLAG_FOR_FOUNDER:(\{.*?\})-->/);
  const cleanText = sonnetResult.text
    .replace(/<!--RERENDER:\{.*?\}-->/g, "")
    .replace(/<!--FLAG_FOR_FOUNDER:\{.*?\}-->/g, "")
    .trim();

  await provider.sendMessage({ to: message.chatId, text: cleanText });

  if (rerenderMatch) {
    try {
      const params = JSON.parse(rerenderMatch[1]);
      // Re-dispatch as synthetic show_view — reuse the same branch logic
      // For simplicity: just call fetchWeeklyView + formatWeeklyText and send
      const weekly = await fetchWeeklyView(
        supabase,
        householdId,
        params.filter_scope || "household",
        params.filter_person || null
      );
      const reRendered = weekly.meta.totalItems <= 2
        ? formatWeeklySparse(weekly)
        : formatWeeklyText(weekly);
      await provider.sendMessage({ to: message.chatId, text: reRendered });
    } catch (e) {
      console.error("[view_feedback] re-render failed:", e);
    }
  }

  if (flagMatch) {
    try {
      const flag = JSON.parse(flagMatch[1]);
      await supabase.from("view_feedback_review").insert({
        household_id: householdId,
        sender_phone: message.senderPhone,
        user_message: message.text,
        last_view_type: config.last_view_type,
        last_view_sent_at: config.last_view_sent_at,
        last_view_content_hash: config.last_view_content_hash,
        last_view_item_count: config.last_view_item_count,
        last_view_scope: config.last_view_scope,
        sonnet_reason: flag.reason || null,
        severity: flag.severity || "medium",
      });
    } catch (e) {
      console.error("[view_feedback] flag insert failed:", e);
    }
  }

  await logMessage(message, "view_feedback", householdId, classification);
  return;
}
```

**Step 3: Deploy + smoke test**

Deploy updated `index.inlined.ts`. From staging household:
1. Send "השבוע" → receive weekly view.
2. Send "זה לא נכון" → expect warm reply, check `view_feedback_review` for the flag row.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts supabase/functions/_shared/reply-generator.ts
git commit -m "feat(bot): view_feedback three-path Sonnet escalation (re-render / clarify / flag)"
```

---

### Task 14: Wire `opt_out_digest` / `opt_in_digest` routing

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Add router branches**

```typescript
case "opt_out_digest": {
  await supabase
    .from("households_v2")
    .update({ weekly_digest_enabled: false })
    .eq("id", householdId);

  await provider.sendMessage({
    to: message.chatId,
    text: "בסדר, לא אשלח תקציר שבועי. תמיד אפשר לשאול 'השבוע' ואראה לכם 🙂",
  });

  await logMessage(message, "opt_out_digest", householdId, classification);
  return;
}

case "opt_in_digest": {
  await supabase
    .from("households_v2")
    .update({ weekly_digest_enabled: true })
    .eq("id", householdId);

  await provider.sendMessage({
    to: message.chatId,
    text: "מעולה! התקציר השבועי חוזר בראשון בבוקר 🌞",
  });

  await logMessage(message, "opt_in_digest", householdId, classification);
  return;
}
```

**Step 2: Deploy + smoke test**

From staging household: send "בלי תקציר שבועי" → receive confirmation + verify `households_v2.weekly_digest_enabled = false`. Then "תחזרו לתקציר שבועי" → reverse.

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): opt_out_digest / opt_in_digest toggles and confirmations"
```

---

### Task 15: Integration test — `show_view: weekly` in group vs 1:1

**Files:**
- Modify: `tests/test_webhook.py`

**Step 1: Write the failing tests**

```python
# Add to tests/test_webhook.py

def test_show_view_weekly_in_group_returns_household_scope():
    """Message 'השבוע' in a group returns household-scoped weekly view."""
    hh = _create_test_household_with_tasks(n_tasks=5)
    msg = _post_message_to_webhook(hh, text="השבוע", chat_type="group")
    assert msg.classification == "show_view"
    assert "השבוע" in msg.reply_text
    assert all(member in msg.reply_text for member in hh.member_names)  # household scope

def test_show_view_weekly_in_1on1_returns_personal_scope():
    """Message 'השבוע' in 1:1 returns only sender's items."""
    hh = _create_test_household_with_tasks(n_tasks=5, assigned_to_two_members=True)
    msg = _post_message_to_webhook(hh, text="השבוע", chat_type="direct", sender=hh.member_names[0])
    assert msg.classification == "show_view"
    assert hh.member_names[0] in msg.reply_text
    assert hh.member_names[1] not in msg.reply_text  # personal filter excludes other member

def test_show_view_weekly_sli_override_in_group():
    """'השבוע שלי' in a group returns only sender's items despite group context."""
    hh = _create_test_household_with_tasks(n_tasks=5, assigned_to_two_members=True)
    msg = _post_message_to_webhook(hh, text="השבוע שלי", chat_type="group", sender=hh.member_names[0])
    assert msg.classification == "show_view"
    assert hh.member_names[1] not in msg.reply_text

def test_show_view_weekly_sparse_returns_inline_not_structured():
    """< 3 items returns one-liner, not the structured view."""
    hh = _create_test_household_with_tasks(n_tasks=1)
    msg = _post_message_to_webhook(hh, text="השבוע")
    assert "📅 השבוע" not in msg.reply_text  # no structured header
    assert "רגוע" in msg.reply_text or "שקט" in msg.reply_text
```

**Step 2: Run to verify they fail initially** (if test helpers don't exist)

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app"
python tests/test_webhook.py::test_show_view_weekly_in_group_returns_household_scope -v
```

Expected: helper functions missing, or real webhook not yet handling `show_view`. Tests should fail on first run.

**Step 3: Add helper functions if missing**

If `_create_test_household_with_tasks` doesn't exist, add it (check existing test_webhook.py for household-creation helpers and extend).

**Step 4: Run all 4 tests**

Expected: PASS on all 4.

**Step 5: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test(views): show_view weekly in group, 1:1, override, sparse"
```

---

### Task 16: Integration test — `view_feedback` flag path

**Files:**
- Modify: `tests/test_webhook.py`

**Step 1: Write the test**

```python
def test_view_feedback_flag_path_writes_review_row():
    """Feedback that can't be re-rendered should flag to founder."""
    hh = _create_test_household_with_tasks(n_tasks=5)
    # Send a weekly view first
    _post_message_to_webhook(hh, text="השבוע")
    # Then send angry/complex feedback that Sonnet will route to flag path
    msg = _post_message_to_webhook(hh, text="זה לגמרי לא נכון, יש באג רציני")
    assert msg.classification == "view_feedback"
    # Check the review row
    rows = _supabase.table("view_feedback_review")\
        .select("*")\
        .eq("household_id", hh.id)\
        .order("created_at", desc=True).limit(1).execute()
    assert len(rows.data) == 1
    assert rows.data[0]["last_view_type"] == "weekly"
    assert rows.data[0]["severity"] in ("low", "medium", "high")
```

**Step 2: Run**

Expected: PASS (Sonnet is non-deterministic; test may flake ~5% per CLAUDE.md "LLM non-determinism" note).

**Step 3: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test(views): view_feedback flag-to-founder path"
```

---

### Task 17: Integration test — opt-out toggle

**Files:**
- Modify: `tests/test_webhook.py`

**Step 1: Write**

```python
def test_opt_out_digest_flips_household_flag():
    hh = _create_test_household_with_tasks(n_tasks=5)
    msg = _post_message_to_webhook(hh, text="בלי תקציר שבועי")
    assert msg.classification == "opt_out_digest"
    row = _supabase.table("households_v2").select("weekly_digest_enabled").eq("id", hh.id).single().execute()
    assert row.data["weekly_digest_enabled"] is False

def test_opt_in_digest_restores_flag():
    hh = _create_test_household_with_tasks(n_tasks=5, weekly_digest_enabled=False)
    msg = _post_message_to_webhook(hh, text="תחזרו לתקציר שבועי")
    assert msg.classification == "opt_in_digest"
    row = _supabase.table("households_v2").select("weekly_digest_enabled").eq("id", hh.id).single().execute()
    assert row.data["weekly_digest_enabled"] is True
```

**Step 2: Run + commit**

```bash
python tests/test_webhook.py -k "opt_out or opt_in" -v
git add tests/test_webhook.py
git commit -m "test(views): opt_out / opt_in digest flag toggles"
```

---

### Task 18: Phase 1 end-to-end smoke test on founder's household

**Step 1: Deploy latest `index.inlined.ts` to production**

Supabase Dashboard → Edge Functions → whatsapp-webhook → Code → paste → Deploy. Verify JWT = OFF.

**Step 2: From the founder's real WhatsApp**

Test matrix:
1. In group: "השבוע" → expect household weekly text.
2. In group: "השבוע שלי" → expect personal-scoped text.
3. In group: "קניות" → expect shopping list text.
4. In group: "היום" → expect today text.
5. In group: "מה עשינו השבוע" → expect retrospective text.
6. In 1:1 bot chat: "השבוע" → expect personal-scoped text.
7. In 1:1: "בלי תקציר שבועי" → expect confirmation; verify `weekly_digest_enabled = false` in DB.
8. In 1:1: "תחזרו לתקציר שבועי" → expect re-enable.
9. In group: "השבוע" then "רוצה לראות גם כביסה" → expect Sonnet feedback handling.

**Step 3: If all 9 work — tag the phase**

```bash
git tag phase-1-views-text-foundation
git push origin main --tags
```

---

## Phase 2 — Sunday push (text only) (tasks 19–23)

**Outcome:** Every Sunday 07:30 IST, `weekly_digest_enabled = true` households get a text weekly view (tier 3-7). Below threshold: silent skip.

---

### Task 19: Migration — create `weekly_digest_queue`

**Step 1: SQL**

```sql
CREATE TABLE IF NOT EXISTS weekly_digest_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | skipped | failed
  skip_reason TEXT,                           -- below_threshold | opted_out | inactive_household | send_failed
  item_count INT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_weekly_digest_queue_pending
  ON weekly_digest_queue(scheduled_for)
  WHERE status = 'pending';

ALTER TABLE weekly_digest_queue ENABLE ROW LEVEL SECURITY;
```

**Step 2: Apply + verify** via `mcp__f5337598__apply_migration` and `mcp__f5337598__list_tables`.

---

### Task 20: pg_cron — Sunday 07:00 enqueue job

**Step 1: SQL**

```sql
-- Check if pg_cron is installed (it should be in Supabase Pro projects)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Enqueue one row per eligible household every Sunday 07:00 IST (= 04:00 UTC in winter, 05:00 UTC in summer — cron runs UTC)
-- For Sunday 07:00 Israel summer time (IDT, UTC+3), cron in UTC:
SELECT cron.schedule(
  'weekly-digest-enqueue',
  '0 4 * * 0',  -- 04:00 UTC Sunday (summer). We accept ±1h drift vs DST for simplicity.
  $$
    INSERT INTO weekly_digest_queue (household_id, scheduled_for)
    SELECT id, NOW() + INTERVAL '30 minutes'
    FROM households_v2
    WHERE weekly_digest_enabled = TRUE
      AND bot_active = TRUE;
  $$
);
```

**Step 2: Apply via `mcp__f5337598__apply_migration`**.

**Step 3: Verify job exists**

```sql
SELECT jobname, schedule, command, active FROM cron.job WHERE jobname = 'weekly-digest-enqueue';
```

Expected: one row, active = true.

---

### Task 21: Worker — process pending digest queue

**Files:**
- Create: `supabase/functions/weekly-digest-worker/index.ts` (new Edge Function)

**Step 1: Write the worker**

```typescript
// supabase/functions/weekly-digest-worker/index.ts
// Triggered every 5 minutes by a Supabase scheduled trigger or external cron.
// Picks up pending rows in weekly_digest_queue where scheduled_for <= now().

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Reuse view-data + formatters + provider from the shared inlined code.
// For now, DUPLICATE the relevant fetchWeeklyView, formatWeeklyText, formatWeeklySparse here,
// or inline them by the same regenerate step we use for the main webhook.

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: pending } = await supabase
    .from("weekly_digest_queue")
    .select("id, household_id")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .limit(20);

  for (const row of pending || []) {
    try {
      const { data: hh } = await supabase
        .from("households_v2")
        .select("id, display_name, primary_chat_id, weekly_digest_enabled, bot_active, founder_joined_at")
        .eq("id", row.household_id)
        .single();

      if (!hh || !hh.weekly_digest_enabled) {
        await supabase.from("weekly_digest_queue").update({ status: "skipped", skip_reason: "opted_out" }).eq("id", row.id);
        continue;
      }
      if (!hh.bot_active) {
        await supabase.from("weekly_digest_queue").update({ status: "skipped", skip_reason: "inactive_household" }).eq("id", row.id);
        continue;
      }

      const weekly = await fetchWeeklyView(supabase, hh.id, "household", null);
      const itemCount = weekly.meta.totalItems;

      // New household (founder joined < 14 days ago) → min 5
      const daysSinceFounder = Math.floor(
        (Date.now() - new Date(hh.founder_joined_at).getTime()) / 86400000
      );
      const minItems = daysSinceFounder < 14 ? 5 : 3;

      if (itemCount < minItems) {
        await supabase.from("weekly_digest_queue").update({
          status: "skipped",
          skip_reason: "below_threshold",
          item_count: itemCount,
        }).eq("id", row.id);
        continue;
      }

      // Phase 2: always text (tier 3-7 and 8+ both render text). Phase 3 promotes 8+ to image.
      const text = formatWeeklyText(weekly);
      await sendWhapiMessage(hh.primary_chat_id, text);

      await supabase.from("weekly_digest_queue").update({
        status: "sent",
        sent_at: new Date().toISOString(),
        item_count: itemCount,
      }).eq("id", row.id);
    } catch (e) {
      console.error(`[weekly-digest] failed for ${row.household_id}:`, e);
      await supabase.from("weekly_digest_queue").update({
        status: "failed",
        skip_reason: "send_failed",
      }).eq("id", row.id);
    }
  }

  return new Response("ok", { status: 200 });
});
```

**Step 2: Inline shared helpers** (same regenerate pattern as index.inlined.ts).

**Step 3: Deploy** via Supabase Dashboard. Add scheduled trigger (every 5 min) via Supabase Dashboard → Edge Functions → Schedule.

**Step 4: Manual test**

Insert a pending row manually:
```sql
INSERT INTO weekly_digest_queue (household_id, scheduled_for)
VALUES ('<founder-household-id>', NOW() - INTERVAL '1 minute');
```
Wait 5 min, check WhatsApp group for digest, verify row status = `sent`.

**Step 5: Commit**

```bash
git add supabase/functions/weekly-digest-worker/
git commit -m "feat(digest): Sunday push worker + pg_cron enqueue (text tier only)"
```

---

### Task 22: Test — threshold logic in worker

**Files:**
- Modify: `tests/test_webhook.py` (add digest-specific section)

**Step 1: Write tests**

```python
def test_digest_worker_skips_household_below_threshold():
    hh = _create_test_household_with_tasks(n_tasks=1)  # only 1 item
    _enqueue_digest(hh.id, scheduled_for_ago_minutes=1)
    _run_digest_worker_once()
    row = _get_digest_row_for(hh.id)
    assert row["status"] == "skipped"
    assert row["skip_reason"] == "below_threshold"

def test_digest_worker_sends_text_for_tier_3_to_7():
    hh = _create_test_household_with_tasks(n_tasks=5)
    _enqueue_digest(hh.id, scheduled_for_ago_minutes=1)
    _run_digest_worker_once()
    row = _get_digest_row_for(hh.id)
    assert row["status"] == "sent"
    assert row["item_count"] == 5

def test_digest_worker_respects_opt_out():
    hh = _create_test_household_with_tasks(n_tasks=5, weekly_digest_enabled=False)
    _enqueue_digest(hh.id, scheduled_for_ago_minutes=1)
    _run_digest_worker_once()
    row = _get_digest_row_for(hh.id)
    assert row["status"] == "skipped"
    assert row["skip_reason"] == "opted_out"
```

**Step 2: Run + commit**

```bash
python tests/test_webhook.py -k "digest_worker" -v
git add tests/test_webhook.py
git commit -m "test(digest): threshold ladder and opt-out in Sunday worker"
```

---

### Task 23: Phase 2 end-to-end: dry-run Sunday push on founder's household

**Step 1: Set scheduled_for to 2 minutes from now**

```sql
INSERT INTO weekly_digest_queue (household_id, scheduled_for)
VALUES ('<founder-household-id>', NOW() + INTERVAL '2 minutes');
```

**Step 2: Wait 7 min** (worker runs every 5). Verify text digest lands in founder group.

**Step 3: Tag**

```bash
git tag phase-2-sunday-push-text
git push origin main --tags
```

---

## Phase 3 — Image rendering (tasks 24–30)

**Outcome:** Tier 8+ renders a portrait PNG via Vercel `@vercel/og` and sends via Whapi `/messages/image`. Fallback to text on failure.

---

### Task 24: Install `@vercel/og` + prepare fonts

**Files:**
- Modify: `package.json`
- Create: `api/weekly-image/fonts/Nunito-Bold.ttf`
- Create: `api/weekly-image/fonts/Heebo-Regular.ttf`
- Create: `api/weekly-image/fonts/Heebo-SemiBold.ttf`

**Step 1: Install**

```bash
cd "C:/Users/yarond/Downloads/claude code/ours-app"
npm install --save @vercel/og
```

**Step 2: Download fonts** from Google Fonts (open-licensed):
- https://fonts.google.com/specimen/Nunito → download Bold TTF
- https://fonts.google.com/specimen/Heebo → download Regular + SemiBold TTFs

Place files in `api/weekly-image/fonts/`.

**Step 3: Commit**

```bash
git add package.json package-lock.json api/weekly-image/fonts/
git commit -m "chore(image): add @vercel/og + Nunito/Heebo fonts"
```

---

### Task 25: Create `api/weekly-image.js` endpoint (scaffold + auth)

**Files:**
- Create: `api/weekly-image.js`

**Step 1: Scaffold with auth**

```javascript
// api/weekly-image.js
import { ImageResponse } from "@vercel/og";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function loadFont(name) {
  const url = new URL(`./weekly-image/fonts/${name}`, import.meta.url);
  return await fetch(url).then((r) => r.arrayBuffer());
}

export default async function handler(req) {
  // Auth: bearer must equal a shared secret (or Supabase service-role JWT)
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.WEEKLY_IMAGE_SECRET}`;
  if (auth !== expected) {
    return new Response("unauthorized", { status: 401 });
  }

  const body = await req.json();
  const { household_id, filter_scope = "household", filter_person = null } = body;
  if (!household_id) return new Response("missing household_id", { status: 400 });

  // Fetch the weekly view server-side (no raw data over wire)
  const weekly = await fetchWeeklyViewForImage(supabase, household_id, filter_scope, filter_person);

  const [heeboReg, heeboSemi, nunitoBold] = await Promise.all([
    loadFont("Heebo-Regular.ttf"),
    loadFont("Heebo-SemiBold.ttf"),
    loadFont("Nunito-Bold.ttf"),
  ]);

  return new ImageResponse(
    renderWeeklyJsx(weekly),
    {
      width: 1080,
      height: 1536,
      fonts: [
        { name: "Heebo", data: heeboReg, weight: 400 },
        { name: "Heebo", data: heeboSemi, weight: 600 },
        { name: "Nunito", data: nunitoBold, weight: 700 },
      ],
    }
  );
}

// Implementations for fetchWeeklyViewForImage + renderWeeklyJsx in Tasks 26–27
```

**Step 2: Add env vars**

In Vercel dashboard → project settings → environment variables:
- `WEEKLY_IMAGE_SECRET` (generate a random 32-byte string, store this same value as Supabase Edge Function env var too)
- `SUPABASE_URL` (already set)
- `SUPABASE_SERVICE_ROLE_KEY` (already set for chat endpoint)

**Step 3: Preview deploy**

```bash
git add api/weekly-image.js
git commit -m "feat(image): scaffold weekly-image Vercel edge route with auth"
git push origin main
```

Vercel auto-deploys. Note the preview URL.

---

### Task 26: Port `fetchWeeklyView` to the Vercel route (mirror of Supabase Edge version)

**Files:**
- Modify: `api/weekly-image.js`

**Step 1: Implement `fetchWeeklyViewForImage`**

Copy the core of `fetchWeeklyView` + `computeWeeklyHorizon` + `fetchRotationsForWindow` from `supabase/functions/_shared/view-data.ts`. Adapt to Node.js (Vercel's @supabase/supabase-js v2 — same API). Keep logic identical so text and image show the same data.

**Step 2: Commit**

```bash
git add api/weekly-image.js
git commit -m "feat(image): port fetchWeeklyView logic to Vercel route"
```

---

### Task 27: Implement the JSX render for the weekly image

**Files:**
- Modify: `api/weekly-image.js`

**Step 1: Write `renderWeeklyJsx`**

Key constraints (from design doc "Image visual brief"):
- 1080×1536, portrait.
- `direction: rtl` at the root.
- Coral `#E8725C` date badges, green `#2AB673` for rotations/today, teal-gray `#1E2D2D` text, warm-white `#FAFCFB` background.
- Heebo 600 for day headers, Heebo 400 for items, Nunito 700 for `sheli` footer.
- Margins 48px, day-gutter 12px.
- Today gets a green "היום" pill on the right.
- Empty days omitted.
- Personal labels "— גילעד" at 70% opacity, smaller.
- Footer: centered `sheli` wordmark + household name.
- NO URL, no CTA.

```javascript
function renderWeeklyJsx(weekly) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: "#FAFCFB",
      padding: 48,
      fontFamily: "Heebo",
      direction: "rtl",
    }}>
      {/* Headline */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 24 }}>
        <span style={{ fontSize: 56, fontWeight: 600, color: "#1E2D2D" }}>השבוע 📅</span>
      </div>

      {/* Days */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {weekly.days.map((day) => (
          <div key={day.date} style={{ display: "flex", flexDirection: "column", padding: 16, backgroundColor: "white", borderRadius: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ backgroundColor: "#E8725C", color: "white", borderRadius: 20, padding: "6px 16px", fontSize: 28, fontWeight: 600 }}>
                  {HE_DAYS[day.dayIndex]} {new Date(day.date).getDate()}/{new Date(day.date).getMonth() + 1}
                </span>
              </div>
              {day.isToday && (
                <span style={{ backgroundColor: "#2AB673", color: "white", borderRadius: 16, padding: "4px 12px", fontSize: 20, fontWeight: 600 }}>
                  היום
                </span>
              )}
            </div>
            {day.rotation && (
              <div style={{ fontSize: 26, color: "#2AB673", marginBottom: 4 }}>
                {day.rotation.icon} {day.rotation.title} — {day.rotation.holder}
              </div>
            )}
            {day.events.map((e) => (
              <div key={e.id} style={{ fontSize: 26, color: "#1E2D2D", marginBottom: 4 }}>
                {e.title} {e.assigned_to && <span style={{ opacity: 0.7, fontSize: 22 }}>— {e.assigned_to}</span>}
              </div>
            ))}
            {day.datedTasks.map((t) => (
              <div key={t.id} style={{ fontSize: 26, color: "#1E2D2D", marginBottom: 4 }}>
                {t.title} {t.assigned_to && <span style={{ opacity: 0.7, fontSize: 22 }}>— {t.assigned_to}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Undated */}
      {weekly.undatedTasks.length > 0 && (
        <div style={{ marginTop: 16, padding: 16, backgroundColor: "white", borderRadius: 12 }}>
          <div style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>📌 ללא תאריך</div>
          {weekly.undatedTasks.slice(0, 5).map((t) => (
            <div key={t.id} style={{ fontSize: 24, color: "#1E2D2D" }}>• {t.title}</div>
          ))}
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: "auto", display: "flex", justifyContent: "center", alignItems: "center", opacity: 0.6, fontFamily: "Nunito", fontWeight: 700, fontSize: 28 }}>
        sheli
      </div>
    </div>
  );
}
```

**Step 2: Deploy to Vercel preview**

```bash
git add api/weekly-image.js
git commit -m "feat(image): render weekly JSX with RTL + design-system palette"
git push origin main
```

**Step 3: Manual QA — RTL + 3 densities**

Using Postman or curl:
```bash
curl -X POST https://<preview>.vercel.app/api/weekly-image \
  -H "Authorization: Bearer $WEEKLY_IMAGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"household_id":"<test-id>"}' \
  --output test.png
open test.png
```

Visually verify: RTL, no mirrored glyphs, today pill correct, overflow behavior, empty-day omission.

---

### Task 28: Add `sendImage` method to `whatsapp-provider.ts`

**Files:**
- Modify: `supabase/functions/_shared/whatsapp-provider.ts`

**Step 1: Add method**

```typescript
async sendImage(
  to: string,
  imageBase64: string,
  caption?: string
): Promise<boolean> {
  try {
    const res = await fetch(`${this.apiUrl}/messages/image`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to,
        media: `data:image/png;base64,${imageBase64}`,
        caption: caption || undefined,
      }),
    });
    if (!res.ok) {
      console.error("[sendImage] failed:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[sendImage] exception:", e);
    return false;
  }
}
```

**Step 2: Regenerate inlined file** (CLAUDE.md rule).

**Step 3: Commit**

```bash
git add supabase/functions/
git commit -m "feat(provider): sendImage method for Whapi /messages/image"
```

---

### Task 29: Upgrade threshold ladder — tier 8+ sends image

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`
- Modify: `supabase/functions/weekly-digest-worker/index.ts`

**Step 1: In the `show_view` branch (weekly), add image path for tier 8+**

```typescript
if (viewType === "weekly") {
  const weekly = await fetchWeeklyView(supabase, householdId, resolvedScope, resolvedPerson);
  itemCount = weekly.meta.totalItems;

  if (itemCount >= 8) {
    // Render image via Vercel
    const imageRes = await fetch(Deno.env.get("WEEKLY_IMAGE_URL")!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("WEEKLY_IMAGE_SECRET")!}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ household_id: householdId, filter_scope: resolvedScope, filter_person: resolvedPerson }),
    });

    if (imageRes.ok) {
      const buf = new Uint8Array(await imageRes.arrayBuffer());
      const b64 = btoa(String.fromCharCode(...buf));
      const sent = await provider.sendImage(message.chatId, b64, "📅 השבוע");
      if (sent) {
        await logMessage(message, "show_view", householdId, classification);
        return;
      }
    }
    // Fallback to text if image failed
    console.warn("[show_view] image failed, fallback to text");
  }

  replyText = itemCount <= 2 ? formatWeeklySparse(weekly) : formatWeeklyText(weekly);
}
```

**Step 2: Same logic in `weekly-digest-worker`** for Sunday push.

**Step 3: Env vars** on Supabase Edge Functions:
- `WEEKLY_IMAGE_URL` = `https://sheli.ai/api/weekly-image`
- `WEEKLY_IMAGE_SECRET` = (same value as Vercel)

**Step 4: Deploy both functions + commit**

```bash
git add supabase/functions/
git commit -m "feat(views): upgrade tier 8+ to image via Vercel weekly-image endpoint"
```

---

### Task 30: End-to-end test — tier 8+ image delivery

**Step 1: Create a test household with 10+ items**

Use the admin dashboard or seed script to create events + tasks bringing total to 10+.

**Step 2: Send "השבוע"** from the test group.

Expected: caption "📅 השבוע" arrives, followed by a PNG image of the weekly view.

**Step 3: Verify Whapi log** — in Whapi dashboard, confirm the `/messages/image` request succeeded.

**Step 4: Tag**

```bash
git tag phase-3-image-rendering
git push origin main --tags
```

---

## Phase 4 — Admin observability + polish (tasks 31–34)

---

### Task 31: Admin dashboard — "Weekly digest" section

**Files:**
- Modify: `src/components/AdminDashboard.jsx`

**Step 1: Add the new section** (details in design doc "Admin observability"):
- Sent / skipped / failed counts for latest Sunday.
- Skip reasons breakdown.
- Sunday-over-Sunday trend.
- Opt-out rate.
- Per-household preview button.

**Step 2: Commit + push + verify in browser**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat(admin): weekly digest observability section"
git push origin main
```

---

### Task 32: Admin dashboard — "View feedback queue" section

**Files:**
- Modify: `src/components/AdminDashboard.jsx`

**Step 1: Add the queue** (details in design doc):
- Unresolved flags, severity-sorted.
- Row actions: "Reply to family", "Mark resolved", "Preview what they saw".
- Counts: open / resolved / avg resolution time.

**Step 2: Commit + push**

```bash
git add src/components/AdminDashboard.jsx
git commit -m "feat(admin): view feedback queue with reply-to-family action"
```

---

### Task 33: Dogfood — one week on founder's household

**Step 1:** Do nothing. Run normally for 7 days. Check:
- Sunday 07:30 push arrives.
- Ad-hoc queries work.
- No `view_feedback_review` flags from yourself.

**Step 2:** Record any issues in a new doc `docs/plans/2026-04-15-whatsapp-visual-views-dogfood-notes.md` (not in scope for this plan; just a reminder).

---

### Task 34: Beta rollout — 5 families + 2-week telemetry

**Step 1:** Deploy to all 5 beta households (automatic — code is already live).

**Step 2:** Monitor telemetry per design doc "Telemetry / success criteria":
- `show_view` calls per household per week (target ≥ 3)
- Image render share (target ≥ 40%)
- Opt-out rate (target ≤ 10%)
- Feedback paths breakdown
- Web-app visits within 2h of show_view (target flat/down)

**Step 3:** After 2 weeks, write a short retrospective into `docs/plans/2026-04-29-whatsapp-visual-views-retrospective.md` covering what shipped, what the metrics say, and whether to build GCal Phase 3 sooner or add view variants (e.g., `show_view: all_tasks`).

---

## Verification summary

**After Phase 1:** text responses work for all 4 views, opt-out toggles the flag, feedback routes to Sonnet 3-path, all on-demand. No Sunday push yet.

**After Phase 2:** Sunday 07:30 push delivers text digests to eligible households (≥ 3 items; ≥ 5 for new households).

**After Phase 3:** tier 8+ households get image digests via Vercel + Whapi. Text fallback on image failure.

**After Phase 4:** admin dashboard surfaces digest metrics and feedback queue. Dogfood + 2-week beta telemetry produce a go/no-go signal for next-phase decisions.

**Target total time:** 8-11 days across all four phases.

---

## Related skills

- `superpowers:executing-plans` — the skill that runs this plan.
- `superpowers:subagent-driven-development` — alternate in-session execution.
- `superpowers:verification-before-completion` — run before tagging any phase.

*Plan complete 2026-04-15. Ready for execution.*
