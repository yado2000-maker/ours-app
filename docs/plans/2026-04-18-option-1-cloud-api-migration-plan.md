# Option 1 Cloud API Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate Sheli from Whapi-only transport to Meta Cloud API, preserving punctual reminders + in-window warmth while reframing externally as a family task coordination utility.

**Architecture:** Single bot number on Cloud API as end-state. In-window reactive replies stay free-form (Sonnet). Proactive outbound (reminders, welcomes, briefings, migration comms) moves to pre-approved Utility templates. Current `55-517-5553` on Whapi serves legacy users reactive-only during transition, sunset ~day 28. Forward-to-task added as MVP flagship feature. All external language audited to remove "AI" framing.

**Tech Stack:** TypeScript (Supabase Edge Functions, Deno), Supabase Postgres + RLS, Meta Cloud API, React 19 (landing page), Python (test runners), pg_cron (scheduled jobs).

**Design doc:** [2026-04-18-option-1-cloud-api-migration-design.md](./2026-04-18-option-1-cloud-api-migration-design.md)

---

## Prerequisites

Before this plan executes:

1. **Ban-recovery branch merged.** `claude/trusting-elbakyan-c75021` (13 commits, includes `outbound_queue`, welcome queue overhaul, day-anchor fix, Haiku 429 retry, `manual_operator_reply`) must be merged to `main`. This plan extends `outbound_queue`, not create it.
2. **24h restriction on `55-517-5553` cleared.** Required before Meta Business verification can complete phone registration.
3. **Meta Business verification submitted.** Already done per session_20260418e; awaiting restriction lift.
4. **New phone number acquired.** Physical SIM or virtual number (eSIM Plus has precedent) for Cloud API registration. Not the same as `55-517-5553` — fresh number with no ban history.

## Branch setup

### Task 0: Create migration branch

**Files:** none (git operation)

**Step 1: Verify prerequisites met**

Run: `git status` → clean. `git log main --oneline -5` → confirm trusting-elbakyan has merged (should see its commits in main).

**Step 2: Create branch**

```bash
cd "C:\Users\yarond\Downloads\claude code\ours-app"
git checkout main
git pull origin main
git checkout -b option-1-cloud-migration
```

**Step 3: Push branch upstream**

```bash
git push -u origin option-1-cloud-migration
```

**Step 4: Verify**

Run: `git branch --show-current` → `option-1-cloud-migration`

---

## Phase 1: Landing page edits (ship independently to main if desired)

### Task 1: Add ForwardIcon to Icons.jsx

**Files:**
- Modify: `src/components/Icons.jsx`

**Step 1: Find a reference icon for pattern**

Read `src/components/Icons.jsx`. Note the existing SVG pattern (stroke-based, `currentColor`, viewBox 24x24 typical).

**Step 2: Add ForwardIcon export**

Append before the closing of the module, following the existing pattern:

```jsx
export const ForwardIcon = ({ size = 24, className = "" }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polyline points="15 17 20 12 15 7" />
    <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
  </svg>
);
```

**Step 3: Visual verify**

Run: `npm run dev` → open landing page in browser → open devtools console → confirm no import errors.

**Step 4: Commit**

```bash
git add src/components/Icons.jsx
git commit -m "feat(icons): add ForwardIcon for forward-to-task feature"
```

---

### Task 2: Replace family-memory card with forward-to-task card

**Files:**
- Modify: `src/components/LandingPage.jsx`
- Modify: `src/locales/he.js` (if translations are externalized)
- Modify: `src/locales/en.js` (if translations are externalized)

**Step 1: Locate the family-memory card**

Grep for the current family-memory card copy:

```bash
grep -n "dog\|mom\|birthday\|remembers" src/components/LandingPage.jsx
```

Identify lines where the card's title, body, and icon reference live.

**Step 2: Replace with forward-to-task card**

Update the card's copy and swap the icon import.

```jsx
// Before: import { FamilyMemoryIcon } from "./Icons";
import { ForwardIcon } from "./Icons";

// Card in feature grid:
<div className="feature-card">
  <ForwardIcon size={48} className="feature-icon" />
  <h3>{t.forwardCard.title}</h3>
  <p>{t.forwardCard.body}</p>
</div>
```

If locales are inline in LandingPage.jsx, replace inline strings.

**Step 3: Update Hebrew strings**

In `src/locales/he.js` (or inline):

```js
forwardCard: {
  title: "העברת הודעות חכמה בלחיצה",
  body: "לחצו 'העבר' על כל הודעת ווטסאפ עם פרטי פגישה, רשימת קניות או תזכורת - ואני אוסיף אוטומטית."
}
```

**Step 4: Update English strings**

In `src/locales/en.js` (or inline):

```js
forwardCard: {
  title: "Smart message forwarding",
  body: "Forward any WhatsApp message - meeting details, a shopping list, a reminder - Sheli turns it into a task automatically."
}
```

**Step 5: Visual verify**

Run: `npm run dev` → open `http://localhost:5173/` → confirm forward-to-task card renders correctly in both HE and EN (toggle language). Icon visible, copy readable, RTL direction preserved.

**Step 6: Commit**

```bash
git add src/components/LandingPage.jsx src/locales/he.js src/locales/en.js
git commit -m "feat(landing): replace family-memory card with forward-to-task card"
```

---

### Task 3: Audit and remove "AI" language from landing page

**Files:**
- Modify: `src/components/LandingPage.jsx`
- Modify: `src/locales/he.js`, `src/locales/en.js`

**Step 1: Audit mentions**

Run (in Grep tool or bash):
```bash
grep -niE "AI|בינה מלאכותית|LLM|chatgpt|chatbot|machine learning|בינה" src/components/LandingPage.jsx src/locales/*.js
```

List every occurrence. Classify each as: keep ("smart"/"חכמה"/"helper"/"assistant" are keepers), replace, or remove.

**Step 2: Replace or remove**

For each flagged phrase:
- "AI assistant" → "smart helper" / "עוזרת חכמה"
- "AI-powered" → drop, or replace with "smart" / "חכם"
- "בינה מלאכותית" → drop, or replace with "חכמה"
- "chatbot" → "WhatsApp helper" / "עוזרת בווטסאפ"
- "LLM / ChatGPT" → drop entirely

**Step 3: Visual verify**

Run: `npm run dev` → scroll the entire landing page in both HE and EN → confirm no remaining AI-flavored copy. Use browser find (Ctrl+F) for each banned term.

**Step 4: Commit**

```bash
git add src/components/LandingPage.jsx src/locales/*.js
git commit -m "copy(landing): remove AI/בינה framing per Option 1 positioning"
```

---

### Task 4: Update Meta Business verification description (external, tracked)

**Files:**
- Create: `docs/meta-verification-copy.md` (internal reference, not deployed)

**Step 1: Draft verification description**

Create `docs/meta-verification-copy.md`:

```markdown
# Meta Business Verification — Service Description

**Business name:** Sheli (שלי)

**Business description (under 512 chars, EN):**
Sheli is a family task coordination service for WhatsApp. Households use Sheli to manage shared shopping lists, chore assignments, event reminders, and household expenses through chat. The WhatsApp interface delivers scheduled reminders, list updates, and confirmations. Behind the scenes, Sheli organizes tasks by category, deadline, and family member. Website: https://sheli.ai

**Business description (HE, for local directory):**
שלי היא שירות לתיאום משימות משפחתיות בווטסאפ. משפחות משתמשות בשלי לניהול רשימות קניות משותפות, חלוקת מטלות, תזכורות לאירועים ומעקב הוצאות משק בית — הכל דרך ווטסאפ. שלי שולחת תזכורות מתוזמנות, עדכוני רשימות ואישורים. הכרטיס הראשי: https://sheli.ai

**Business category:** Productivity / Household Services
**Sub-category:** Task Management
```

**Step 2: Commit**

```bash
git add docs/meta-verification-copy.md
git commit -m "docs: Meta Business verification copy (utility framing)"
```

**Step 3: Paste into Meta Business Manager**

Operational, not code. When 24h restriction lifts, paste the description into Meta Business Manager → Business Info → Description.

---

## Phase 2: Schema migrations + infrastructure primitives

### Task 5: Schema migration for outbound_queue + tasks

**Files:**
- Create: `supabase/migrations/2026_04_19_option1_schema.sql`

**Step 1: Write migration**

```sql
-- Cloud API migration: extend outbound_queue with template support,
-- extend tasks with source tracking for forward-to-task.

-- outbound_queue: template routing
ALTER TABLE outbound_queue
  ADD COLUMN IF NOT EXISTS template_id TEXT,
  ADD COLUMN IF NOT EXISTS template_variables JSONB,
  ADD COLUMN IF NOT EXISTS transport TEXT DEFAULT 'whapi'
    CHECK (transport IN ('whapi', 'cloud_api'));

-- Index for drain-by-transport queries
CREATE INDEX IF NOT EXISTS outbound_queue_transport_idx
  ON outbound_queue (transport, status, created_at);

-- tasks: source tracking for forward-to-task
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'chat'
    CHECK (source IN ('chat', 'forward', 'web', 'voice')),
  ADD COLUMN IF NOT EXISTS source_message_id TEXT;
```

**Step 2: Apply migration**

Use the MCP tool `mcp__f5337598__apply_migration` with name `2026_04_19_option1_schema` and the SQL above.

**Step 3: Verify**

Run via MCP `execute_sql`:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name IN ('outbound_queue', 'tasks')
  AND column_name IN ('template_id', 'template_variables', 'transport', 'source', 'source_message_id');
```

Expected: 5 rows returned.

**Step 4: Commit**

```bash
git add supabase/migrations/2026_04_19_option1_schema.sql
git commit -m "feat(db): add template + transport columns to outbound_queue, source to tasks"
```

---

### Task 6: Create templates.ts registry

**Files:**
- Create: `supabase/functions/_shared/templates.ts`
- Create: `supabase/functions/_shared/templates.test.ts`

**Step 1: Write the failing test**

```typescript
// supabase/functions/_shared/templates.test.ts
import { assertEquals, assertThrows } from "https://deno.land/std/assert/mod.ts";
import { TEMPLATES, renderTemplate, TemplateId } from "./templates.ts";

Deno.test("renderTemplate: reminder_fire populates variable", () => {
  const rendered = renderTemplate("reminder_fire", { reminderText: "לקנות חלב" });
  assertEquals(rendered, "⏰ היי, תזכורת: לקנות חלב");
});

Deno.test("renderTemplate: event_fire populates two variables", () => {
  const rendered = renderTemplate("event_fire", { delta: "שעה", title: "פגישה עם רינה" });
  assertEquals(rendered, "📅 בעוד שעה: פגישה עם רינה");
});

Deno.test("renderTemplate: welcome_direct includes forward tip line", () => {
  const rendered = renderTemplate("welcome_direct", { firstName: "דנה" });
  assertEquals(rendered.includes("היי דנה!"), true);
  assertEquals(rendered.includes("💡 אפשר גם להעביר אליי"), true);
});

Deno.test("renderTemplate: rejects unknown template", () => {
  assertThrows(() => renderTemplate("nonexistent" as TemplateId, {}));
});

Deno.test("TEMPLATES: all registered have body and variables schema", () => {
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    assertEquals(typeof tpl.body, "string");
    assertEquals(Array.isArray(tpl.variables), true);
  }
});
```

**Step 2: Run tests to verify they fail**

```bash
deno test supabase/functions/_shared/templates.test.ts
```

Expected: all FAIL with "Cannot find module" or similar.

**Step 3: Write templates.ts**

```typescript
// supabase/functions/_shared/templates.ts
// Immutable template registry. Editing a body requires a NEW template ID
// (e.g. reminder_fire_v2) + new Meta approval. Do not edit in place.

export type TemplateId =
  | "reminder_fire"
  | "event_fire"
  | "welcome_direct"
  | "welcome_group"
  | "morning_briefing"
  | "number_change_notice";

interface TemplateDef {
  metaName: string;      // Meta-approved template name (submission key)
  category: "UTILITY";
  language: "he";
  variables: string[];   // ordered list of variable keys
  body: string;          // rendering template with {{key}} placeholders
}

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  reminder_fire: {
    metaName: "reminder_fire",
    category: "UTILITY",
    language: "he",
    variables: ["reminderText"],
    body: "⏰ היי, תזכורת: {{reminderText}}",
  },
  event_fire: {
    metaName: "event_fire",
    category: "UTILITY",
    language: "he",
    variables: ["delta", "title"],
    body: "📅 בעוד {{delta}}: {{title}}",
  },
  welcome_direct: {
    metaName: "welcome_direct",
    category: "UTILITY",
    language: "he",
    variables: ["firstName"],
    body:
      "היי {{firstName}}! אני שלי, נעים מאד! 🧡\n\n" +
      "כתבו לי מה צריך לקנות, מה להזכיר לכם ואיזה מטלות יש לכם - ואני אסדר הכל.\n\n" +
      "💡 אפשר גם להעביר אליי כל הודעת ווטסאפ ואוסיף למשימות.\n\n" +
      "רוצים את כל המשפחה? הוסיפו אותי לווטסאפ המשפחתי ואסדר הכל לכולם",
  },
  welcome_group: {
    metaName: "welcome_group",
    category: "UTILITY",
    language: "he",
    variables: [],
    body:
      "שלום לכולם! אני שלי, נעים מאד! 🧡\n\n" +
      "כתבו לי מה צריך לקנות, מה להזכיר לכם ואיזה מטלות יש לכם - ואני אסדר הכל למשפחה.\n\n" +
      "לצפייה ברשימות: sheli.ai",
  },
  morning_briefing: {
    metaName: "morning_briefing",
    category: "UTILITY",
    language: "he",
    variables: ["summary"],
    body: "בוקר טוב! מה להיום: {{summary}}.",
  },
  number_change_notice: {
    metaName: "number_change_notice",
    category: "UTILITY",
    language: "he",
    variables: ["newNumber"],
    body:
      "היי זאת שלי! עברתי למספר חדש: {{newNumber}}.\n\n" +
      "שמרו את המספר והוסיפו לקבוצת הווטסאפ המשפחתית במקום הישן.",
  },
};

export function renderTemplate<T extends TemplateId>(
  id: T,
  variables: Record<string, string>,
): string {
  const tpl = TEMPLATES[id];
  if (!tpl) throw new Error(`Unknown template: ${id}`);

  // Verify all required variables present
  for (const required of tpl.variables) {
    if (!(required in variables)) {
      throw new Error(`Template ${id} missing variable: ${required}`);
    }
  }

  let rendered = tpl.body;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}
```

**Step 4: Run tests to verify they pass**

```bash
deno test supabase/functions/_shared/templates.test.ts
```

Expected: all 5 tests PASS.

**Step 5: Commit**

```bash
git add supabase/functions/_shared/templates.ts supabase/functions/_shared/templates.test.ts
git commit -m "feat(bot): templates.ts registry with 6 Hebrew utility templates"
```

---

### Task 7: Create list-renderer.ts

**Files:**
- Create: `supabase/functions/_shared/list-renderer.ts`
- Create: `supabase/functions/_shared/list-renderer.test.ts`

**Step 1: Write failing tests**

```typescript
// supabase/functions/_shared/list-renderer.test.ts
import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { renderList } from "./list-renderer.ts";

const tasks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    title: `מטלה ${i + 1}`,
    dueDate: `2026-04-${20 + i}`,
  }));

Deno.test("renderList: 3 tasks renders full inline", () => {
  const out = renderList({ type: "task", items: tasks(3) });
  assertEquals(out.includes("3 מטלות"), true);
  assertEquals(out.includes("מטלה 1"), true);
  assertEquals(out.includes("מטלה 3"), true);
  assertEquals(out.includes("sheli.ai"), false);
});

Deno.test("renderList: 8 tasks renders full bulleted", () => {
  const out = renderList({ type: "task", items: tasks(8) });
  assertEquals(out.includes("8 מטלות"), true);
  assertEquals(out.split("•").length, 9); // 8 bullets + prefix
  assertEquals(out.includes("sheli.ai"), false);
});

Deno.test("renderList: 25 tasks caps at 5 + link", () => {
  const out = renderList({ type: "task", items: tasks(25) });
  assertEquals(out.includes("25 מטלות"), true);
  assertEquals(out.includes("5 הדחופות"), true);
  assertEquals(out.includes("sheli.ai/tasks"), true);
  assertEquals(out.includes("מטלה 5"), true);
  assertEquals(out.includes("מטלה 6"), false); // capped
});

Deno.test("renderList: expenses always link even for 1 item", () => {
  const out = renderList({
    type: "expense",
    items: [{ title: "חשמל", amount: 250 }],
  });
  assertEquals(out.includes("sheli.ai/expenses"), true);
});

Deno.test("renderList: empty list short message", () => {
  const out = renderList({ type: "task", items: [] });
  assertEquals(out.includes("אין"), true);
});
```

**Step 2: Run to fail**

```bash
deno test supabase/functions/_shared/list-renderer.test.ts
```

Expected: all FAIL.

**Step 3: Implement**

```typescript
// supabase/functions/_shared/list-renderer.ts
type ListItem = { title: string; dueDate?: string; amount?: number };
type ListType = "task" | "shopping" | "event" | "expense" | "reminder";

interface RenderArgs {
  type: ListType;
  items: ListItem[];
}

const LABELS: Record<ListType, { plural: string; webPath: string }> = {
  task: { plural: "מטלות", webPath: "/tasks" },
  shopping: { plural: "פריטים ברשימת קניות", webPath: "/shopping" },
  event: { plural: "אירועים", webPath: "/events" },
  expense: { plural: "הוצאות", webPath: "/expenses" },
  reminder: { plural: "תזכורות", webPath: "/reminders" },
};

export function renderList({ type, items }: RenderArgs): string {
  const label = LABELS[type];
  const n = items.length;

  if (n === 0) {
    return `אין ${label.plural} כרגע 🧡`;
  }

  // Expenses always go to web (money audit trail + multi-currency)
  if (type === "expense") {
    return (
      `יש לכם ${n} ${label.plural}. ` +
      `לצפייה מלאה: sheli.ai${label.webPath}`
    );
  }

  if (n <= 5) {
    const list = items.map((i) => i.title).join(", ");
    return `יש לכם ${n} ${label.plural}: ${list}.`;
  }

  if (n <= 10) {
    const bullets = items.map((i) => `• ${i.title}`).join("\n");
    return `הנה ${label.plural} שלכם:\n${bullets}`;
  }

  // n > 10: top 5 + link
  const top5 = items.slice(0, 5).map((i) => `• ${i.title}`).join("\n");
  return (
    `יש לכם ${n} ${label.plural}. הנה 5 הדחופות:\n${top5}\n\n` +
    `הרשימה המלאה: sheli.ai${label.webPath}`
  );
}
```

**Step 4: Run to pass**

```bash
deno test supabase/functions/_shared/list-renderer.test.ts
```

Expected: all 5 PASS.

**Step 5: Commit**

```bash
git add supabase/functions/_shared/list-renderer.ts supabase/functions/_shared/list-renderer.test.ts
git commit -m "feat(bot): list-renderer with deterministic cap+link at >10 items"
```

---

### Task 8: Create forward-handler.ts

**Files:**
- Create: `supabase/functions/_shared/forward-handler.ts`
- Create: `supabase/functions/_shared/forward-handler.test.ts`

**Step 1: Write failing tests**

```typescript
// supabase/functions/_shared/forward-handler.test.ts
import { assertEquals } from "https://deno.land/std/assert/mod.ts";
import { isForwarded, extractTaskFromForward } from "./forward-handler.ts";

Deno.test("isForwarded: Whapi context.forwarded true", () => {
  assertEquals(isForwarded({ context: { forwarded: true } } as any), true);
});

Deno.test("isForwarded: Cloud API forwarded flag true", () => {
  assertEquals(isForwarded({ forwarded: true } as any), true);
});

Deno.test("isForwarded: regular message returns false", () => {
  assertEquals(isForwarded({ text: "hello" } as any), false);
});

Deno.test("extractTaskFromForward: truncates long body for classifier", () => {
  const longBody = "א".repeat(1000);
  const result = extractTaskFromForward(longBody, () => ({
    title: "טסט",
    dueDate: null,
  }));
  assertEquals(result.classifierInput.length, 500);
  assertEquals(result.notes.length, 1000);
});
```

**Step 2: Run to fail, then implement**

```typescript
// supabase/functions/_shared/forward-handler.ts
interface MessagePayload {
  context?: { forwarded?: boolean };
  forwarded?: boolean;
  text?: string;
}

export function isForwarded(msg: MessagePayload): boolean {
  return Boolean(msg.context?.forwarded || msg.forwarded);
}

interface TaskExtraction {
  title: string;
  dueDate: string | null;
}

interface ExtractResult {
  classifierInput: string;
  notes: string;
  task: TaskExtraction;
}

export function extractTaskFromForward(
  body: string,
  classifier: (input: string) => TaskExtraction,
): ExtractResult {
  const classifierInput = body.slice(0, 500);
  const task = classifier(classifierInput);
  return {
    classifierInput,
    notes: body,
    task,
  };
}
```

**Step 3: Run to pass**

```bash
deno test supabase/functions/_shared/forward-handler.test.ts
```

Expected: all PASS.

**Step 4: Commit**

```bash
git add supabase/functions/_shared/forward-handler.ts supabase/functions/_shared/forward-handler.test.ts
git commit -m "feat(bot): forward-handler for detection + task extraction"
```

---

## Phase 3: Cloud API provider + webhook integration

### Task 9: Create CloudApiProvider

**Files:**
- Create: `supabase/functions/_shared/cloud-api-provider.ts`

**Step 1: Read existing Whapi provider for reference**

Read `supabase/functions/_shared/whatsapp-provider.ts` — match its interface shape. Note `sendMessage(phone, text): Promise<SendResult>` signature and `{ ok, messageId }` return.

**Step 2: Write CloudApiProvider**

```typescript
// supabase/functions/_shared/cloud-api-provider.ts
import { renderTemplate, TemplateId, TEMPLATES } from "./templates.ts";

interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export class CloudApiProvider {
  constructor(
    private accessToken: string,
    private phoneNumberId: string, // Meta phone_number_id, not E.164
  ) {}

  private get apiBase() {
    return `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async sendMessage(to: string, text: string): Promise<SendResult> {
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    };

    const res = await fetch(this.apiBase, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, messageId: data.messages?.[0]?.id };
  }

  async sendTemplate<T extends TemplateId>(
    to: string,
    templateId: T,
    variables: Record<string, string>,
  ): Promise<SendResult> {
    const tpl = TEMPLATES[templateId];
    if (!tpl) return { ok: false, error: `Unknown template: ${templateId}` };

    // Positional variables per Meta spec
    const orderedVars = tpl.variables.map((key) => ({
      type: "text",
      text: variables[key] ?? "",
    }));

    const body = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: tpl.metaName,
        language: { code: tpl.language },
        components: orderedVars.length
          ? [{ type: "body", parameters: orderedVars }]
          : [],
      },
    };

    const res = await fetch(this.apiBase, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, messageId: data.messages?.[0]?.id };
  }
}
```

**Step 3: Type-check**

```bash
deno check supabase/functions/_shared/cloud-api-provider.ts
```

Expected: no errors.

**Step 4: Commit**

```bash
git add supabase/functions/_shared/cloud-api-provider.ts
git commit -m "feat(bot): CloudApiProvider with sendMessage + sendTemplate"
```

---

### Task 10: Regenerate index.inlined.ts with new modules

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Plan the edits**

Inline the 4 new modules (`templates.ts`, `list-renderer.ts`, `forward-handler.ts`, `cloud-api-provider.ts`) into `index.inlined.ts`. Placement: after existing `_shared` inlines, before handler logic.

**Step 2: Provider selection logic**

Add near top of `index.inlined.ts` after existing provider setup:

```typescript
// Transport selection: cohort-based during migration
// - Cohort 'cloud_api': uses CloudApiProvider
// - Cohort 'whapi': uses existing WhapiProvider (reactive-only in Option 1)
function selectProvider(householdId: string | null): "whapi" | "cloud_api" {
  // Migration flag: new households → cloud_api, legacy → whapi
  // Populated via migration_cohort column on households_v2, default 'whapi'
  // Cohort flipping happens in Task 14.
  return globalThis.PROVIDER_COHORT?.[householdId ?? ""] ?? "whapi";
}
```

**Step 3: Parse-check**

Per CLAUDE.md mandatory pre-deploy check:

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

Expected: exit code 0, no syntax errors.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): inline templates/list-renderer/forward-handler/cloud-api into webhook"
```

---

### Task 11: Integrate forward-to-task into webhook handler

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Locate inbound message processing**

Grep for the function that routes inbound messages to Haiku (likely `handleIncoming` or similar in the inlined file). Identify where the Haiku classification call happens.

**Step 2: Add forward short-circuit before Haiku**

Before the Haiku call, add:

```typescript
if (isForwarded(message)) {
  const body = message.text ?? "";
  if (!body) {
    await sendAndLog(phone, "אני עוד לא יודעת לקרוא תמונות - שלחו לי את הפרטים כטקסט ואוסיף.", {
      replyType: "forward_no_text",
    });
    return;
  }

  // Use Haiku with narrow forward-extraction prompt
  const extraction = await haikuExtractForwardTask(body.slice(0, 500));
  const taskId = await createTask({
    householdId,
    title: extraction.title,
    dueDate: extraction.dueDate,
    source: "forward",
    sourceMessageId: message.messageId,
    notes: body,
  });

  await sendAndLog(phone, `הוספתי מההודעה ששלחת: ${extraction.title} ✅`, {
    replyType: "forward_task_created",
  });
  return;
}
```

**Step 3: Add haikuExtractForwardTask function**

Create specialized classifier prompt that returns `{title, dueDate}` JSON. Prompt body:

```typescript
const FORWARD_EXTRACTION_PROMPT = `
You extract task information from a forwarded WhatsApp message.

Return JSON only: {"title": "<short task title in Hebrew, max 80 chars>", "dueDate": "<ISO 8601 date or null>"}

Rules:
- title: extract the core action/thing to remember. If the message is a list, use the first item or a summary.
- dueDate: extract if explicitly mentioned (tomorrow, Sunday, March 15, etc). Return null if absent.
- Current time: ${new Date().toISOString()}
- Timezone: Asia/Jerusalem

Message:
"""
{{BODY}}
"""
`;

async function haikuExtractForwardTask(body: string): Promise<{ title: string; dueDate: string | null }> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: FORWARD_EXTRACTION_PROMPT.replace("{{BODY}}", body),
    }],
  });
  const text = response.content[0].type === "text" ? response.content[0].text : "";
  try {
    return JSON.parse(text);
  } catch {
    return { title: body.slice(0, 80), dueDate: null };
  }
}
```

**Step 4: Parse-check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts \
  --bundle --platform=neutral --format=esm --target=esnext \
  --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* \
  --outfile=/tmp/bundle_test.js
```

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): forward-to-task routing with dedicated Haiku extraction"
```

---

### Task 12: Integrate list-renderer into reactive query path

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Locate the `question` intent handler**

Grep for where `intent === "question"` is routed to Sonnet. This is the current prose-generation path.

**Step 2: Detect list-type questions**

Before the Sonnet call, check if the question is a list query. Simple pattern match:

```typescript
function detectListQuery(text: string): "task" | "shopping" | "event" | "expense" | null {
  const normalized = text.toLowerCase();
  if (/מטלות|דברים לעשות|to.?do/i.test(text)) return "task";
  if (/קניות|רשימה|shopping/i.test(text)) return "shopping";
  if (/אירועים|פגישות|events/i.test(text)) return "event";
  if (/הוצאות|כמה הוצאנו|expenses/i.test(text)) return "expense";
  return null;
}
```

**Step 3: Route list queries to renderer**

```typescript
if (intent === "question") {
  const listType = detectListQuery(message.text);
  if (listType) {
    const items = await fetchItems(householdId, listType);
    const rendered = renderList({ type: listType, items });
    await sendAndLog(phone, rendered, { replyType: "list_query" });
    return;
  }
  // Fall through to Sonnet for non-list questions
}
```

**Step 4: Add fetchItems helper**

```typescript
async function fetchItems(householdId: string, type: string): Promise<ListItem[]> {
  const tableMap = {
    task: { table: "tasks", where: "done = false", order: "due_date asc nulls last" },
    shopping: { table: "shopping_items", where: "got = false", order: "created_at desc" },
    event: { table: "events", where: "scheduled_for > now()", order: "scheduled_for asc" },
    expense: { table: "expenses", where: "deleted = false", order: "occurred_at desc" },
  };
  const cfg = tableMap[type];
  const { data } = await supabase.from(cfg.table)
    .select("*")
    .eq("household_id", householdId)
    .order(cfg.order.split(" ")[0]);
  return (data ?? []).map((row) => ({
    title: row.title ?? row.description ?? row.item ?? "",
    dueDate: row.due_date ?? row.scheduled_for ?? row.occurred_at,
    amount: row.amount_minor ? row.amount_minor / 100 : undefined,
  }));
}
```

**Step 5: Parse-check + commit**

```bash
npx --yes esbuild ... (same as before)
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): route list queries to deterministic renderer, Sonnet only for non-list"
```

---

### Task 13: Swap reminder_queue firing to templates

**Files:**
- Modify: reminder firing function (likely in `supabase/migrations/` or edge function)

**Step 1: Locate current firing logic**

Grep:
```bash
grep -rn "reminder_queue\|send_at\|fire_reminder" supabase/
```

Identify the function that dequeues due reminders and sends messages.

**Step 2: Replace prose generation with template send**

Wherever the reminder body is currently built (possibly via Sonnet or string concat), replace with:

```typescript
// For Cloud API cohort
if (selectProvider(householdId) === "cloud_api") {
  await cloudApi.sendTemplate(phone, "reminder_fire", {
    reminderText: reminder.message_text,
  });
} else {
  // Legacy Whapi cohort: existing free-form send (will be retired at cutover)
  await whapi.sendMessage(phone, `⏰ ${reminder.message_text}`);
}
```

**Step 3: Test locally against staging number (if possible) or via unit test**

Mock `sendTemplate` and verify the right template ID + variables are used for the cloud_api cohort.

**Step 4: Commit**

```bash
git add supabase/migrations/* supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): reminder_queue firing uses reminder_fire template on cloud_api cohort"
```

---

### Task 14: Add migration_cohort column to households_v2

**Files:**
- Create: `supabase/migrations/2026_04_19_migration_cohort.sql`

**Step 1: Write migration**

```sql
ALTER TABLE households_v2
  ADD COLUMN IF NOT EXISTS migration_cohort TEXT DEFAULT 'whapi'
    CHECK (migration_cohort IN ('whapi', 'cloud_api'));

CREATE INDEX IF NOT EXISTS households_migration_cohort_idx
  ON households_v2 (migration_cohort);
```

**Step 2: Apply via MCP, verify, commit**

```bash
git add supabase/migrations/2026_04_19_migration_cohort.sql
git commit -m "feat(db): migration_cohort column for phased Cloud API rollout"
```

**Step 3: Update provider selection in webhook**

Replace the stubbed `selectProvider` in `index.inlined.ts` with a real lookup:

```typescript
async function selectProvider(householdId: string | null): Promise<"whapi" | "cloud_api"> {
  if (!householdId) return "whapi"; // pre-household messages stay on legacy
  const { data } = await supabase.from("households_v2")
    .select("migration_cohort")
    .eq("id", householdId)
    .maybeSingle();
  return (data?.migration_cohort as "whapi" | "cloud_api") ?? "whapi";
}
```

Cache the result per-message to avoid repeated lookups.

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(bot): real selectProvider from households_v2.migration_cohort"
```

---

## Phase 4: Retire banned outbound paths (Whapi cohort)

### Task 15: Disable nudge pg_cron job

**Files:**
- Create: `supabase/migrations/2026_04_19_disable_nudge_cron.sql`

**Step 1: Write migration**

```sql
-- Retire re-engagement nudges per Option 1 positioning.
-- Anti-spam risk pattern; users self-engage via web app instead.
SELECT cron.unschedule('onboarding_nudge_job') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'onboarding_nudge_job'
);
```

**Step 2: Apply, commit**

```bash
git add supabase/migrations/2026_04_19_disable_nudge_cron.sql
git commit -m "refactor(bot): retire onboarding nudge cron (Option 1 outbound discipline)"
```

---

### Task 16: Disable welcome blast drain logic

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (remove welcome blast drain)

**Step 1: Locate**

Grep `index.inlined.ts` for the welcome queue drain function. From session_20260418d memory, it was overhauled during the ban recovery.

**Step 2: Guard behind cohort**

Rather than deleting, guard the drain to only fire for cloud_api cohort households. But since cloud_api cohort uses `welcome_direct` template on first-contact (reactive, in-window, user-initiated), the blast path is effectively dead code:

```typescript
// RETIRED: welcome blasts removed per Option 1 positioning.
// Welcomes now only fire on user-initiated first contact (reactive, in-window).
// Dead code kept for 30 days then removed in a cleanup pass.
```

Comment out the drain registration or pg_cron entry, do not delete the function body yet.

**Step 3: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "refactor(bot): retire welcome blast drain (reactive-only welcomes now)"
```

---

## Phase 5: Tests

### Task 17: Extend test_webhook.py with forward fixtures

**Files:**
- Modify: `tests/test_webhook.py`

**Step 1: Add forward-to-task test cases**

Add a new test group:

```python
FORWARD_CASES = [
    {
        "name": "forward_with_meeting",
        "payload": {
            "text": "נפגשים מחר בשעה 15:00 בקפה ארומה",
            "context": {"forwarded": True},
        },
        "expected_intent": None,  # bypasses classifier
        "expected_reply_pattern": r"הוספתי מההודעה",
        "db_check": lambda hh: count_tasks(hh, source="forward") == 1,
    },
    {
        "name": "forward_plain_task",
        "payload": {
            "text": "לקנות חלב בדרך חזרה",
            "context": {"forwarded": True},
        },
        "expected_reply_pattern": r"הוספתי",
        "db_check": lambda hh: count_tasks(hh, source="forward") == 1,
    },
    {
        "name": "forward_empty_text_media_placeholder",
        "payload": {
            "text": "",
            "context": {"forwarded": True},
            "has_media": True,
        },
        "expected_reply_pattern": r"אני עוד לא יודעת לקרוא תמונות",
    },
]
```

**Step 2: Add a helper `count_tasks`**

```python
def count_tasks(household_id, source=None):
    q = supabase.table("tasks").select("*").eq("household_id", household_id)
    if source:
        q = q.eq("source", source)
    return len(q.execute().data)
```

**Step 3: Run test locally**

```bash
python tests/test_webhook.py --category Forward
```

Expected: at least 2 of 3 pass (media case may need staging deploy first).

**Step 4: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test(bot): forward-to-task integration cases"
```

---

## Phase 6: Operational cutover (manual / guided)

### Task 18: Submit 6 templates to Meta for approval

**Operational, not code.**

In Meta Business Manager → WhatsApp Manager → Message Templates → Create. For each of the 6 templates in `supabase/functions/_shared/templates.ts`:

- Name: match `metaName` field
- Category: UTILITY
- Language: Hebrew
- Body: paste from the `body` field, replace `{{key}}` with `{{1}}`, `{{2}}` positional Meta-style

Submit all 6. Typical approval: 24–72h.

**Track status:** add a checklist in `docs/meta-verification-copy.md`.

---

### Task 19: Acquire new phone, register with Cloud API

**Operational.**

1. Purchase new SIM or virtual number (eSIM Plus).
2. In Meta Business Manager → WhatsApp Business Accounts → Add Phone Number.
3. Complete phone verification (SMS or voice OTP).
4. Copy `phone_number_id` and `access_token` into Supabase Edge Function secrets:
   - `CLOUD_API_PHONE_NUMBER_ID`
   - `CLOUD_API_ACCESS_TOKEN`
   - `CLOUD_API_BOT_PHONE` (E.164 of the new number)

---

### Task 20: Deploy webhook with dual-transport support

**Operational + code.**

1. Ensure `index.inlined.ts` includes both WhapiProvider and CloudApiProvider and `selectProvider` logic.
2. Deploy via Supabase Dashboard paste (Verify JWT = OFF).
3. Smoke test: send from a new test number → verify Cloud API call succeeds, message lands.
4. Smoke test: send from an existing beta household → verify Whapi still handles it.

---

### Task 21: Cutover new-user onboarding to new number

**Files:**
- Modify: `src/components/LandingPage.jsx` (update `wa.me/` link to new number)
- Modify: `public/` or wherever the WhatsApp CTA href lives

**Step 1: Find all references to old number**

```bash
grep -rn "972555175553\|55-517-5553\|555175553" src/ public/
```

**Step 2: Replace with new number everywhere**

Swap old → new in all CTAs, landing page, FAQ, meta tags.

**Step 3: Deploy**

```bash
git add src/ public/
git commit -m "feat(landing): point WhatsApp CTAs to new Cloud API number"
git push
```

Vercel auto-deploys from main. Verify live site.

---

### Task 22: Group migration comms (manual, paced)

**Operational.**

For each active beta family group (Goldberg, La Familia, Ventura, Kaye, Hadad):

1. Open the group in WhatsApp on `55-517-5553` (Whapi).
2. Manually post the migration announcement (uses `number_change_notice` template text but sent free-form in-group, since the bot is a member and it's inside an active conversation):
   ```
   היי זאת שלי! עברתי למספר חדש: <NEW_NUMBER>.

   שמרו את המספר והוסיפו לקבוצת הווטסאפ המשפחתית במקום הישן.
   ```
3. Help the founder add the new number to the group.
4. Set that household's `migration_cohort = 'cloud_api'`:
   ```sql
   UPDATE households_v2 SET migration_cohort = 'cloud_api' WHERE id = '<hh_id>';
   ```
5. Flag in a tracking spreadsheet.

Pace: 1–2 households per day. No broadcasts. No cold 1:1 outreach.

---

### Task 23: Whapi sunset

**Operational.**

After ≥80% of households are on cloud_api:

1. Confirm `reminder_queue` pg_cron has zero firings on `whapi` cohort for 7 consecutive days.
2. Disable Whapi webhook endpoint (return 410 Gone).
3. Cancel Whapi subscription.
4. Delete `whapi-provider.ts` code path. Replace `selectProvider` with hardcoded `cloud_api`.
5. Drop `migration_cohort` column (post-migration cleanup).

```bash
git checkout main
git merge option-1-cloud-migration
git push
```

---

## Success criteria

- [ ] All 6 templates approved by Meta
- [ ] New Cloud API number verified and live
- [ ] Zero proactive outbound from Whapi for 14 consecutive days before sunset
- [ ] ≥80% of beta households message the new number at least once
- [ ] Zero second-ban events during migration
- [ ] Reminder-firing success rate on new number ≥95% (matches current Whapi baseline)
- [ ] Forward-to-task extraction accuracy ≥85% on the 20-case Hebrew fixture set
- [ ] Landing page AI-language audit clean (zero matches for banned terms)

## Rollback

If Meta approves templates but Cloud API behaves unexpectedly:
- Revert `selectProvider` to always return `"whapi"` (single-line change)
- Existing users continue as-is on legacy Whapi
- Investigate, fix, re-deploy

If Meta rejects core templates (`reminder_fire` or `welcome_direct`):
- Refine copy based on rejection reason, resubmit
- Migration phase 6 waits on approval
- Phases 1–5 code can still merge (infrastructure ready, just not yet in use)

If a second ban hits:
- Immediately fall back to pure Boti formula: all proactive outbound disabled, new number reactive-only
- Kill `reminder_queue` pg_cron entirely
- Reassess product promise at that point (reminders-at-time may need to become check-in-style)
