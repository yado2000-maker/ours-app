# Expenses Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add WhatsApp-first expense tracking with multi-currency, 4 attribution modes, 1:1 privacy, and a read-only web view.

**Architecture:** Two new intents (`add_expense`, `query_expense`) in the existing Haiku→Sonnet pipeline, one new `expenses` table in Supabase, action executor cases, and a new `ExpensesTab.jsx` read-only view. Controlled rollout via `EXPENSES_ENABLED` env var.

**Tech Stack:** Supabase (Postgres + RLS + Realtime), Deno (Edge Function), React 19, Anthropic Claude (Haiku 4.5 + Sonnet 4)

**Design doc:** `docs/plans/2026-04-16-expenses-design.md`

---

### Task 1: Database Migration — `expenses` table

**Files:**
- Create: Supabase migration via MCP tool (`mcp__f5337598__apply_migration`)

**Step 1: Apply the migration**

Run via Supabase MCP `apply_migration`:

```sql
-- Create expenses table
CREATE TABLE public.expenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id      UUID NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  currency          TEXT NOT NULL DEFAULT 'ILS',
  description       TEXT NOT NULL,
  category          TEXT,
  paid_by           TEXT,
  attribution       TEXT NOT NULL CHECK (attribution IN ('speaker','named','joint','household')),
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  visibility        TEXT NOT NULL DEFAULT 'household' CHECK (visibility IN ('household','private')),
  source            TEXT NOT NULL DEFAULT 'whatsapp',
  source_message_id TEXT,
  logged_by_phone   TEXT,
  edited            BOOLEAN NOT NULL DEFAULT false,
  deleted           BOOLEAN NOT NULL DEFAULT false,
  deleted_at        TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_expenses_household_occurred ON expenses(household_id, occurred_at DESC) WHERE deleted = false;
CREATE INDEX idx_expenses_household_category ON expenses(household_id, category) WHERE deleted = false;
CREATE INDEX idx_expenses_household_currency ON expenses(household_id, currency) WHERE deleted = false;
CREATE INDEX idx_expenses_source_message ON expenses(source_message_id) WHERE source_message_id IS NOT NULL;

-- RLS
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "household_members_select" ON expenses
  FOR SELECT USING (is_household_member(household_id));
CREATE POLICY "household_members_insert" ON expenses
  FOR INSERT WITH CHECK (is_household_member(household_id));
CREATE POLICY "household_members_update" ON expenses
  FOR UPDATE USING (is_household_member(household_id))
             WITH CHECK (is_household_member(household_id));
CREATE POLICY "household_members_delete" ON expenses
  FOR DELETE USING (is_household_member(household_id));

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;
```

**Step 2: Verify migration succeeded**

Run via MCP `list_tables` — confirm `expenses` appears with all columns. Run via MCP `execute_sql`:

```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'expenses' ORDER BY ordinal_position;
```

Expected: 18 columns matching the schema above.

**Step 3: Commit**

```bash
git add docs/plans/2026-04-16-expenses-design.md docs/plans/2026-04-16-expenses-plan.md
git commit -m "docs: add expenses feature design and implementation plan"
```

---

### Task 2: TypeScript Types + `parseAmount()` Helper

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (lines 75-127 — types section, and add helper function near line 1840)

**Step 1: Add `add_expense` and `query_expense` to `ClassificationOutput.intent` union type**

In `index.inlined.ts` around line 75, add to the intent union:

```typescript
// After "delete_memory" (line 91):
    | "add_expense"
    | "query_expense";
```

**Step 2: Add expense entity fields to the `entities` interface**

After the existing entity fields (around line 125), add:

```typescript
    // Expenses (v0)
    amount_text?: string;
    amount_minor?: number;
    expense_currency?: string; // "ILS" | "USD" | "EUR" | "GBP"
    expense_description?: string;
    expense_category?: string;
    expense_attribution?: "speaker" | "named" | "joint" | "household";
    expense_paid_by_name?: string;
    expense_occurred_at_hint?: string;
    expense_visibility_hint?: "household" | "private";
    // Query expense
    expense_query_type?: "summary" | "category_in_period";
    expense_query_category?: string;
    expense_query_period?: "this_month" | "last_month";
    expense_query_period_start?: string;
    expense_query_period_end?: string;
```

**Step 3: Add `add_expense` to the `ClassifiedAction.type` union**

At line 166, add `"add_expense"` to the union:

```typescript
type: "add_task" | "add_shopping" | "add_event" | "complete_task" | "complete_shopping" | "add_reminder" | "assign_task" | "create_rotation" | "override_rotation" | "complete_shopping_by_names" | "complete_tasks_all_open" | "add_expense";
```

**Step 4: Write `parseAmountToMinor()` helper**

Add this helper function BEFORE the `executeActions` function (around line 1835):

```typescript
// ─── Expense Amount Parser ───

const CURRENCY_MAP: Record<string, string> = {
  "₪": "ILS", "שקל": "ILS", "שקלים": "ILS", "ש״ח": "ILS", "שח": "ILS", "nis": "ILS", "ils": "ILS",
  "$": "USD", "דולר": "USD", "דולרים": "USD", "usd": "USD", "dollars": "USD", "dollar": "USD",
  "€": "EUR", "יורו": "EUR", "אירו": "EUR", "eur": "EUR", "euro": "EUR", "euros": "EUR",
  "£": "GBP", "פאונד": "GBP", "לירה": "GBP", "gbp": "GBP", "pound": "GBP", "pounds": "GBP",
};

const MINOR_UNIT: Record<string, number> = {
  ILS: 100, USD: 100, EUR: 100, GBP: 100, JPY: 1,
};

const HEB_NUMBERS: Record<string, number> = {
  "אלף": 1000, "אלפיים": 2000, "מאה": 100, "מאתיים": 200,
  "שלוש מאות": 300, "ארבע מאות": 400, "חמש מאות": 500,
  "שש מאות": 600, "שבע מאות": 700, "שמונה מאות": 800, "תשע מאות": 900,
};

function parseAmountToMinor(
  amountText: string | undefined,
  haikuMinor: number | undefined,
  currency: string
): { amount_minor: number; currency: string } | null {
  const unit = MINOR_UNIT[currency] || 100;

  // Try Haiku's parsed value first
  if (haikuMinor && haikuMinor > 0) {
    return { amount_minor: haikuMinor, currency };
  }

  if (!amountText) return null;

  // Clean: remove currency symbols, commas, whitespace
  let cleaned = amountText.trim()
    .replace(/[₪$€£]/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Try direct numeric parse
  const num = parseFloat(cleaned);
  if (!isNaN(num) && num > 0) {
    return { amount_minor: Math.round(num * unit), currency };
  }

  // Try "1.3K" / "1.3k" style
  const kMatch = cleaned.match(/^([\d.]+)\s*[kK]$/);
  if (kMatch) {
    const val = parseFloat(kMatch[1]) * 1000;
    if (!isNaN(val) && val > 0) return { amount_minor: Math.round(val * unit), currency };
  }

  // Try Hebrew word numbers (basic: "אלף ושלוש מאות" = 1300)
  let total = 0;
  const parts = cleaned.replace(/ו/g, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const twoWord = i + 1 < parts.length ? `${parts[i]} ${parts[i + 1]}` : "";
    if (HEB_NUMBERS[twoWord]) {
      total += HEB_NUMBERS[twoWord];
      i++; // skip next word
    } else if (HEB_NUMBERS[parts[i]]) {
      total += HEB_NUMBERS[parts[i]];
    }
  }
  if (total > 0) return { amount_minor: Math.round(total * unit), currency };

  return null;
}

function resolveExpenseAttribution(
  attribution: string | undefined,
  paidByName: string | undefined,
  senderName: string | undefined
): { paid_by: string | null; attribution: string } {
  switch (attribution) {
    case "named":
      return { paid_by: paidByName || senderName || null, attribution: "named" };
    case "joint":
      return { paid_by: null, attribution: "joint" };
    case "household":
      return { paid_by: null, attribution: "household" };
    case "speaker":
    default:
      return { paid_by: senderName || null, attribution: "speaker" };
  }
}
```

**Step 5: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

Expected: no errors.

**Step 6: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(expenses): add types and parseAmount helper to webhook"
```

---

### Task 3: Haiku Classifier Prompt — Add `add_expense` + `query_expense` Intents

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (lines 509-600 — Haiku prompt)

**Step 1: Add intent definitions**

In the INTENTS section (after the `add_reminder` definition around line 567), add:

```
- add_expense: Logging a household payment. Hebrew triggers: "שילמתי", "שילמנו", "שולם", "[name] שילם/שילמה". Must include an amount (number or Hebrew word). Category inferred from description. Attribution: speaker (שילמתי), named (אבא שילם), joint (שילמנו/ביחד), household (שולם, passive voice). Multi-currency: default ILS. Explicit: "יורו"/"euro"/"€" → EUR, "דולר"/"$" → USD, "פאונד"/"£" → GBP.
  - NOT expense: "שילמתי עליו" (treating someone socially, not household expense). "המשכנתא עולה X" (price statement, not payment). "לשלם חשמל" (TODO/task, not completed payment). Shopping with price ("חלב ב-12 שקל") = add_shopping, not expense.
  - NOT task: "שילמתי X" is PAST TENSE (already paid). "לשלם X" is FUTURE (task). Never classify a payment as add_task.
- query_expense: Asking about household spending. Triggers: "כמה שילמנו", "תסכמי הוצאות", "סיכום הוצאות". Has a period (this_month/last_month) and optional category.
```

**Step 2: Add examples in the EXAMPLES section**

Find the examples section (around line 720+) and add:

```
[User]: "שילמתי 1300 חשמל" → {"intent":"add_expense","confidence":0.95,"entities":{"amount_text":"1300","amount_minor":130000,"expense_currency":"ILS","expense_description":"חשמל","expense_category":"חשמל","expense_attribution":"speaker","raw_text":"שילמתי 1300 חשמל"}}
[User]: "אבא שילם 500 סופר" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"500","amount_minor":50000,"expense_currency":"ILS","expense_description":"סופר","expense_category":"מזון","expense_attribution":"named","expense_paid_by_name":"אבא","raw_text":"אבא שילם 500 סופר"}}
[User]: "שילמנו 2400 ארנונה" → {"intent":"add_expense","confidence":0.94,"entities":{"amount_text":"2400","amount_minor":240000,"expense_currency":"ILS","expense_description":"ארנונה","expense_category":"ארנונה","expense_attribution":"joint","raw_text":"שילמנו 2400 ארנונה"}}
[User]: "שולם 180 ביטוח" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"180","amount_minor":18000,"expense_currency":"ILS","expense_description":"ביטוח","expense_category":"ביטוח","expense_attribution":"household","raw_text":"שולם 180 ביטוח"}}
[User]: "שילמתי 150 יורו דלק" → {"intent":"add_expense","confidence":0.93,"entities":{"amount_text":"150","amount_minor":15000,"expense_currency":"EUR","expense_description":"דלק","expense_category":"דלק","expense_attribution":"speaker","raw_text":"שילמתי 150 יורו דלק"}}
[User]: "כמה שילמנו החודש?" → {"intent":"query_expense","confidence":0.92,"addressed_to_bot":true,"entities":{"expense_query_type":"summary","expense_query_period":"this_month","raw_text":"כמה שילמנו החודש?"}}
[User]: "כמה שילמנו חשמל החודש?" → {"intent":"query_expense","confidence":0.93,"addressed_to_bot":true,"entities":{"expense_query_type":"category_in_period","expense_query_category":"חשמל","expense_query_period":"this_month","raw_text":"כמה שילמנו חשמל החודש?"}}
[User]: "תסכמי לנו את ההוצאות בחודש שעבר" → {"intent":"query_expense","confidence":0.94,"addressed_to_bot":true,"entities":{"expense_query_type":"summary","expense_query_period":"last_month","raw_text":"תסכמי לנו את ההוצאות בחודש שעבר"}}
```

**Step 3: Add negative examples**

In the negative examples / disambiguation section:

```
[User]: "שילמתי עליו 50 בבית קפה" → {"intent":"ignore","confidence":0.88,"entities":{"raw_text":"שילמתי עליו 50 בבית קפה"}}  // social treating, not household expense
[User]: "המשכנתא עולה 4000" → {"intent":"ignore","confidence":0.85,"entities":{"raw_text":"המשכנתא עולה 4000"}}  // price statement, not payment event
[User]: "לשלם חשמל" → {"intent":"add_task","confidence":0.90,"entities":{"title":"לשלם חשמל","raw_text":"לשלם חשמל"}}  // future action = task, not expense
[User]: "שילמתי לו 500 לעבודה שעשה" → {"intent":"add_expense","confidence":0.90,"entities":{"amount_text":"500","amount_minor":50000,"expense_currency":"ILS","expense_description":"עבודה","expense_attribution":"speaker","raw_text":"שילמתי לו 500 לעבודה שעשה"}}  // "paid him" = valid expense
```

**Step 4: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 5: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(expenses): add add_expense and query_expense to Haiku classifier prompt"
```

---

### Task 4: Action Executor — `add_expense` Case

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (line ~2040 — inside `executeActions` switch, after `complete_shopping`)

**Step 1: Add the `add_expense` case**

Inside `executeActions()` (around line 1851), after the last existing case (before the closing `default:`), add:

```typescript
        case "add_expense": {
          const {
            amount_text, amount_minor: haikuAmount,
            expense_currency, expense_description, expense_category,
            expense_attribution, expense_paid_by_name,
            expense_occurred_at_hint, expense_visibility_hint
          } = action.data as Record<string, any>;

          const currency = (expense_currency || "ILS").toUpperCase();
          const parsed = parseAmountToMinor(amount_text, haikuAmount, currency);

          if (!parsed || parsed.amount_minor < 50 || parsed.amount_minor > 100_000_000) {
            // Suspicious amount — log but skip insert
            console.warn(`[Expense] Suspicious amount: text="${amount_text}" minor=${haikuAmount} currency=${currency}`);
            summary.push(`Expense-skipped: suspicious amount "${amount_text}"`);
            break;
          }

          const { paid_by, attribution } = resolveExpenseAttribution(
            expense_attribution, expense_paid_by_name, senderName
          );

          const expenseId = uid4();
          const { error } = await supabase.from("expenses").insert({
            id: expenseId,
            household_id: householdId,
            amount_minor: parsed.amount_minor,
            currency: parsed.currency,
            description: expense_description || "הוצאה",
            category: expense_category || expense_description || "אחר",
            paid_by,
            attribution,
            occurred_at: expense_occurred_at_hint || new Date().toISOString(),
            visibility: expense_visibility_hint || "household",
            source: "whatsapp",
            logged_by_phone: senderName || null,
          });
          if (error) throw error;

          const displayAmount = (parsed.amount_minor / (MINOR_UNIT[parsed.currency] || 100)).toLocaleString("he-IL");
          const currencySymbol = parsed.currency === "ILS" ? "₪" : parsed.currency === "EUR" ? "€" : parsed.currency === "USD" ? "$" : parsed.currency === "GBP" ? "£" : parsed.currency;
          summary.push(`Expense: ${currencySymbol}${displayAmount} ${expense_description || "הוצאה"}${paid_by ? ` (${paid_by})` : ""}`);
          break;
        }
```

**Step 2: Wire `add_expense` into the Haiku→action routing**

Find the section where Haiku classification maps to `ClassifiedAction[]` (around line 938-1000 in `buildReplyPrompt`, and also the actionable-intent routing in the main handler). 

In the switch inside `buildReplyPrompt` (around line 941), add after the last existing case:

```typescript
    case "add_expense":
      actionSummary = `An expense was just logged: ${e.expense_currency || "ILS"} ${e.amount_text || "?"} for "${e.expense_description || "?"}". Attribution: ${e.expense_attribution || "speaker"}${e.expense_paid_by_name ? `, paid by ${e.expense_paid_by_name}` : ""}.`;
      break;
    case "query_expense":
      // Query results will be injected separately
      actionSummary = `User is asking about expenses. Query type: ${e.expense_query_type}. Period: ${e.expense_query_period}. Category: ${e.expense_query_category || "all"}.`;
      break;
```

Also find the section that maps Haiku intents to actions (search for the switch that builds the `actions` array, around line 5990-6200). Add:

```typescript
    case "add_expense": {
      actions.push({
        type: "add_expense",
        data: {
          amount_text: entities.amount_text,
          amount_minor: entities.amount_minor,
          expense_currency: entities.expense_currency,
          expense_description: entities.expense_description,
          expense_category: entities.expense_category,
          expense_attribution: entities.expense_attribution,
          expense_paid_by_name: entities.expense_paid_by_name,
          expense_occurred_at_hint: entities.expense_occurred_at_hint,
          expense_visibility_hint: entities.expense_visibility_hint,
        },
      });
      break;
    }
```

**Step 3: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(expenses): add_expense action executor and intent-to-action routing"
```

---

### Task 5: Query Expense Handler

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts`

**Step 1: Add `executeQueryExpense()` function**

Add before `executeActions()` (around line 1835):

```typescript
// ─── Expense Query Executor ───

function getExpensePeriodRange(period: string): { start: string; end: string } {
  const now = new Date();
  const israelOffset = 3 * 60 * 60 * 1000; // +03:00
  const israelNow = new Date(now.getTime() + israelOffset);
  
  if (period === "last_month") {
    const y = israelNow.getMonth() === 0 ? israelNow.getFullYear() - 1 : israelNow.getFullYear();
    const m = israelNow.getMonth() === 0 ? 11 : israelNow.getMonth() - 1;
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0, 23, 59, 59);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  // Default: this_month
  const start = new Date(israelNow.getFullYear(), israelNow.getMonth(), 1);
  const end = new Date(israelNow.getFullYear(), israelNow.getMonth() + 1, 0, 23, 59, 59);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function executeQueryExpense(
  householdId: string,
  entities: Record<string, any>,
  isDirectMessage: boolean,
  senderPhone?: string
): Promise<string> {
  const period = entities.expense_query_period || "this_month";
  const { start, end } = entities.expense_query_period_start && entities.expense_query_period_end
    ? { start: entities.expense_query_period_start, end: entities.expense_query_period_end }
    : getExpensePeriodRange(period);

  let query = supabase
    .from("expenses")
    .select("amount_minor, currency, category, paid_by, occurred_at, visibility")
    .eq("household_id", householdId)
    .eq("deleted", false)
    .gte("occurred_at", start)
    .lte("occurred_at", end);

  // In group context, only show household-visible expenses
  if (!isDirectMessage) {
    query = query.eq("visibility", "household");
  }

  if (entities.expense_query_type === "category_in_period" && entities.expense_query_category) {
    query = query.ilike("category", `%${entities.expense_query_category}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[QueryExpense] Error:", error);
    return "EXPENSE_QUERY_ERROR";
  }

  const rows = data || [];
  if (rows.length === 0) {
    const periodLabel = period === "last_month" ? "בחודש שעבר" : "החודש";
    return `EXPENSE_QUERY_RESULT: 0 expenses in ${periodLabel}. No data.`;
  }

  // Group by currency
  const byCurrency: Record<string, { total: number; count: number; byCategory: Record<string, number> }> = {};
  for (const row of rows) {
    const cur = row.currency || "ILS";
    if (!byCurrency[cur]) byCurrency[cur] = { total: 0, count: 0, byCategory: {} };
    byCurrency[cur].total += row.amount_minor;
    byCurrency[cur].count++;
    const cat = row.category || "אחר";
    byCurrency[cur].byCategory[cat] = (byCurrency[cur].byCategory[cat] || 0) + row.amount_minor;
  }

  const unit = (cur: string) => (MINOR_UNIT[cur] || 100);
  const sym = (cur: string) => cur === "ILS" ? "₪" : cur === "EUR" ? "€" : cur === "USD" ? "$" : cur === "GBP" ? "£" : cur;

  let result = "EXPENSE_QUERY_RESULT:\n";
  const periodLabel = period === "last_month" ? "בחודש שעבר" : "החודש";

  for (const [cur, data] of Object.entries(byCurrency)) {
    const totalDisplay = (data.total / unit(cur)).toLocaleString("he-IL");
    result += `${periodLabel}: ${sym(cur)}${totalDisplay} (${data.count} הוצאות)\n`;

    // Top 3 categories
    const sorted = Object.entries(data.byCategory)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
    if (sorted.length > 0 && entities.expense_query_type !== "category_in_period") {
      const catStr = sorted.map(([cat, amt]) => `${cat} (${sym(cur)}${(amt / unit(cur)).toLocaleString("he-IL")})`).join(", ");
      result += `הכי גדולות: ${catStr}\n`;
    }
  }

  return result;
}
```

**Step 2: Wire query_expense into the main handler**

Find where `query_expense` would be routed (in the intent→action switch). Unlike other intents, `query_expense` doesn't go through `executeActions` — it pre-fetches data and injects into Sonnet's prompt context.

In the main handler, where actionable intents are processed, add a branch:

```typescript
    case "query_expense": {
      // Don't go through executeActions — fetch data and let Sonnet format the reply
      const queryResult = await executeQueryExpense(
        householdId,
        classification.entities,
        isDirectMessage,
        message.senderPhone
      );
      // Inject query result into the reply prompt context
      // (add to actionSummary so Sonnet sees it)
      break;
    }
```

The exact wiring depends on the existing handler structure — search for the switch that routes intents to `executeActions` vs reply-only paths. `query_expense` follows the same pattern as `question` intent: respond=true, actions=[], but with query data injected into the Sonnet prompt.

**Step 3: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(expenses): add query_expense handler with per-currency aggregation"
```

---

### Task 6: Sonnet Reply Prompt — Expense Confirmation + Query Formatting

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (around line 905 — `buildReplyPrompt`)

**Step 1: Add expense reply guidelines to the Sonnet prompt**

In `buildReplyPrompt`, find where intent-specific guidelines are given to Sonnet (in the template string). Add after the existing intent guidelines:

```
EXPENSE LOGGING (add_expense):
When an expense was just logged, confirm in one SHORT line. Include: amount with currency symbol, category, who paid (use "מי שילם:" label).
Examples:
- "רשמתי — 1,300 ₪ חשמל, מי שילם: [name] ✓"
- "רשמתי — 500 ₪ סופר, מי שילם: אבא ✓"  
- "רשמתי — 2,400 ₪ ארנונה, שילמתם ביחד ✓"
- "רשמתי — 150 € דלק, מי שילם: [name] ✓"
For amounts >1000: add 💸 emoji. For new category first time: add "שמרתי בהיסטוריה."
For attribution=household: omit "מי שילם:" entirely.
For attribution=joint: say "שילמתם ביחד" instead of "מי שילם:".

EXPENSE QUERY (query_expense):
The EXPENSE_QUERY_RESULT data is provided. Format it naturally in Hebrew.
- Summary: "ב[period]: סה״כ [N] ₪ על פני [K] הוצאות. הכי גדולות: [cat1] ([X]), [cat2] ([Y])."
- Category: "[Category] ב[period]: [N] ₪ ([K] תשלומים)."
- Multi-currency: show each currency on its own line. NEVER sum across currencies.
- Zero state: "עדיין לא רשמנו הוצאות ב[period]. ספרו לי כשמשלמים — 'שילמתי X על Y'."
CRITICAL: NEVER fabricate totals. If query returned 0, say so.
```

**Step 2: Update the `buildReplyPrompt` actionSummary switch** (already added in Task 4)

Verify the `case "add_expense"` and `case "query_expense"` entries from Task 4 are present. If `query_expense` has a `queryResult` string, it should be appended to `actionSummary`:

```typescript
    case "query_expense":
      // queryResult is injected into context before buildReplyPrompt is called
      actionSummary = `User is asking about expenses. ${(classification as any).__queryResult || "No query result available."}`;
      break;
```

**Step 3: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(expenses): add Sonnet reply templates for expense confirm and query"
```

---

### Task 7: Update `countHouseholdActions` + Quick-Undo Support

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (line ~2519 — `countHouseholdActions`, and ~4077 undo section)

**Step 1: Add expenses to the action count**

At line 2519, update `countHouseholdActions` to include expenses:

```typescript
async function countHouseholdActions(householdId: string | null): Promise<number> {
  if (!householdId) return 0;
  const [t, s, e, r, exp] = await Promise.all([
    supabase.from("tasks").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("shopping_items").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("events").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("reminder_queue").select("id", { count: "exact", head: true }).eq("household_id", householdId),
    supabase.from("expenses").select("id", { count: "exact", head: true }).eq("household_id", householdId).eq("deleted", false),
  ]);
  return (t.count || 0) + (s.count || 0) + (e.count || 0) + (r.count || 0) + (exp.count || 0);
}
```

**Step 2: Add expense undo to the quick-undo handler**

Find the quick-undo handler (near line 4077+ where `UNDO_KEYWORDS` is used). The undo handler looks for the bot's last action and reverses it. Add expense soft-delete as a reversal option.

When the bot's last action was `add_expense` and user says "תמחקי" / "בטלי" within 60s:

```typescript
// Inside the undo handler, add expense undo:
if (lastBotAction?.type === "add_expense" && lastBotAction.data?.expenseId) {
  await supabase.from("expenses")
    .update({ deleted: true, deleted_at: new Date().toISOString() })
    .eq("id", lastBotAction.data.expenseId)
    .eq("household_id", householdId);
  // Send confirmation
}
```

Note: this requires storing the `expenseId` in the bot action log. In the `add_expense` executor (Task 4), ensure the `expenseId` is included in the logged action data.

**Step 3: Run esbuild parse check**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(expenses): add expenses to action count and quick-undo support"
```

---

### Task 8: Feature Flag + Edge Function Deploy

**Files:**
- Modify: `supabase/functions/whatsapp-webhook/index.inlined.ts` (main handler)

**Step 1: Add `EXPENSES_ENABLED` env var check**

At the top of the expense-related routing (where `add_expense` and `query_expense` intents are handled), add:

```typescript
const EXPENSES_ENABLED = Deno.env.get("EXPENSES_ENABLED") === "true";

// In the intent routing:
if ((classification.intent === "add_expense" || classification.intent === "query_expense") && !EXPENSES_ENABLED) {
  // Silently treat as ignore — feature not yet enabled
  classification.intent = "ignore" as any;
  classification.confidence = 1.0;
}
```

**Step 2: Run full esbuild parse check (final)**

```bash
npx --yes esbuild supabase/functions/whatsapp-webhook/index.inlined.ts --bundle --platform=neutral --format=esm --target=esnext --loader:.ts=ts --external:jsr:* --external:npm:* --external:https:* --outfile=/tmp/bundle_test.js
```

Expected: no errors.

**Step 3: Deploy Edge Function**

Open `index.inlined.ts` in Cursor/VS Code → Ctrl+A, Ctrl+C → Supabase Dashboard → Functions → whatsapp-webhook → Code tab → paste → Deploy. Verify JWT = OFF.

Set env var: `EXPENSES_ENABLED=false` (keep off until Task 11 testing).

**Step 4: Commit**

```bash
git add supabase/functions/whatsapp-webhook/index.inlined.ts
git commit -m "feat(expenses): add EXPENSES_ENABLED feature flag, deploy-ready"
```

---

### Task 9: Web App — `src/lib/supabase.js` Helpers

**Files:**
- Modify: `src/lib/supabase.js` (add expense field map + load function)

**Step 1: Add the EXPENSE_MAP and loadExpenses function**

After the existing `EVENT_MAP` (line 8), add:

```javascript
const EXPENSE_MAP = {
  amountMinor: 'amount_minor',
  paidBy: 'paid_by',
  occurredAt: 'occurred_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  sourceMessageId: 'source_message_id',
  loggedByPhone: 'logged_by_phone',
  deletedAt: 'deleted_at',
};
```

After the existing `loadMessages` function, add:

```javascript
export const loadExpenses = async (hhId, { period = 'this_month', category = 'all' } = {}) => {
  const now = new Date();
  let start, end;
  if (period === 'last_month') {
    const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const m = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    start = new Date(y, m, 1).toISOString();
    end = new Date(y, m + 1, 0, 23, 59, 59).toISOString();
  } else if (period === 'all_time') {
    start = '2020-01-01T00:00:00Z';
    end = new Date(2099, 0).toISOString();
  } else {
    // this_month
    start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
  }

  let q = supabase.from("expenses")
    .select("*")
    .eq("household_id", hhId)
    .eq("deleted", false)
    .eq("visibility", "household")  // web v0: only household-visible
    .gte("occurred_at", start)
    .lte("occurred_at", end)
    .order("occurred_at", { ascending: false })
    .limit(200);

  if (category && category !== 'all') {
    q = q.eq("category", category);
  }

  const { data, error } = await q;
  if (error) { console.error("[loadExpenses]", error); return []; }
  return (data || []).map(e => fromDb(e, EXPENSE_MAP));
};
```

**Step 2: Add expenses to `loadHousehold`**

At line 36, add expenses to the parallel fetch:

```javascript
export const loadHousehold = async (hhId) => {
  const [hhRes, membersRes, tasksRes, shoppingRes, eventsRes, rotationsRes, expensesRes] = await Promise.all([
    supabase.from("households_v2").select("*").eq("id", hhId).single(),
    supabase.from("household_members").select("*").eq("household_id", hhId),
    supabase.from("tasks").select("*").eq("household_id", hhId),
    supabase.from("shopping_items").select("*").eq("household_id", hhId),
    supabase.from("events").select("*").eq("household_id", hhId),
    supabase.from("rotations").select("*").eq("household_id", hhId).eq("active", true),
    supabase.from("expenses").select("*").eq("household_id", hhId).eq("deleted", false).eq("visibility", "household").order("occurred_at", { ascending: false }).limit(100),
  ]);
```

And in the return object, add:

```javascript
    expenses: (expensesRes.data || []).map(e => fromDb(e, EXPENSE_MAP)),
```

**Step 3: Commit**

```bash
git add src/lib/supabase.js
git commit -m "feat(expenses): add loadExpenses helper and expense field mapper"
```

---

### Task 10: Web App — `ExpensesView.jsx` Component + Nav Tab

**Files:**
- Create: `src/components/ExpensesView.jsx`
- Modify: `src/App.jsx` (add tab + import)
- Modify: `src/components/Icons.jsx` (add ReceiptIcon)
- Modify: `src/locales/he.js` (add expense strings)
- Modify: `src/locales/en.js` (add expense strings)

**Step 1: Add ReceiptIcon to Icons.jsx**

In `src/components/Icons.jsx`, add after the last existing icon export:

```jsx
export const ReceiptIcon = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2Z" />
    <path d="M8 10h8" />
    <path d="M8 14h4" />
  </svg>
);
```

**Step 2: Add locale strings**

In `src/locales/he.js`, add to the export object:

```javascript
  navExpenses: "הוצאות",
  expensesTitle: "הוצאות",
  expensesEmpty: "עדיין לא רשמנו הוצאות. ספרו לשלי בווטסאפ — 'שילמתי X על Y'.",
  expensesTotal: "סה״כ",
  expensesPaidBy: "מי שילם:",
  expensesJoint: "ביחד",
  expensesNotSpecified: "לא צוין",
  expensesThisMonth: "החודש",
  expensesLastMonth: "חודש שעבר",
  expensesAllTime: "הכל",
  expensesAllCategories: "כל הקטגוריות",
  expensesAddViaWA: "הוסיפו בווטסאפ",
  expensesEditHint: "לעריכה, כתבו לשלי בווטסאפ",
  expensesCount: "הוצאות",
```

In `src/locales/en.js`, add:

```javascript
  navExpenses: "Expenses",
  expensesTitle: "Expenses",
  expensesEmpty: "No expenses logged yet. Tell Sheli on WhatsApp — 'I paid X for Y'.",
  expensesTotal: "Total",
  expensesPaidBy: "Paid by:",
  expensesJoint: "Together",
  expensesNotSpecified: "Not specified",
  expensesThisMonth: "This month",
  expensesLastMonth: "Last month",
  expensesAllTime: "All time",
  expensesAllCategories: "All categories",
  expensesAddViaWA: "Add via WhatsApp",
  expensesEditHint: "To edit, message Sheli on WhatsApp",
  expensesCount: "expenses",
```

**Step 3: Create `ExpensesView.jsx`**

Create `src/components/ExpensesView.jsx`:

```jsx
import { useState, useMemo } from "react";

const CURRENCY_SYMBOL = { ILS: "₪", USD: "$", EUR: "€", GBP: "£" };
const MINOR_UNIT = { ILS: 100, USD: 100, EUR: 100, GBP: 100, JPY: 1 };

function formatAmount(amountMinor, currency) {
  const unit = MINOR_UNIT[currency] || 100;
  const sym = CURRENCY_SYMBOL[currency] || currency;
  const val = (amountMinor / unit).toLocaleString("he-IL");
  return `${sym}${val}`;
}

function timeAgo(dateStr, t) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `לפני ${mins} דק׳`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  const days = Math.floor(hours / 24);
  if (days === 0) return "היום";
  if (days === 1) return "אתמול";
  return `לפני ${days} ימים`;
}

export default function ExpensesView({ expenses = [], t, loading }) {
  const [period, setPeriod] = useState("this_month");
  const [categoryFilter, setCategoryFilter] = useState("all");

  // Filter by period (already filtered server-side, but we keep the state for the dropdown)
  const filtered = useMemo(() => {
    if (categoryFilter === "all") return expenses;
    return expenses.filter(e => e.category === categoryFilter);
  }, [expenses, categoryFilter]);

  // Unique categories from loaded data
  const categories = useMemo(() => {
    const cats = new Set(expenses.map(e => e.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [expenses]);

  // Totals per currency
  const totals = useMemo(() => {
    const byCurrency = {};
    for (const e of filtered) {
      const cur = e.currency || "ILS";
      if (!byCurrency[cur]) byCurrency[cur] = { total: 0, count: 0 };
      byCurrency[cur].total += e.amountMinor || e.amount_minor || 0;
      byCurrency[cur].count++;
    }
    return byCurrency;
  }, [filtered]);

  if (loading) return <div className="tab-loading">⏳</div>;

  return (
    <div className="expenses-view" style={{ padding: "12px 16px" }}>
      {/* Filter row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select
          value={period}
          onChange={e => setPeriod(e.target.value)}
          style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border, #ddd)", background: "var(--card-bg, #fff)", fontSize: 14 }}
        >
          <option value="this_month">{t.expensesThisMonth}</option>
          <option value="last_month">{t.expensesLastMonth}</option>
          <option value="all_time">{t.expensesAllTime}</option>
        </select>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{ flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border, #ddd)", background: "var(--card-bg, #fff)", fontSize: 14 }}
        >
          <option value="all">{t.expensesAllCategories}</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Summary card */}
      {Object.keys(totals).length > 0 && (
        <div style={{
          background: "var(--card-bg, #fff)", borderRadius: 12,
          padding: "14px 16px", marginBottom: 12,
          border: "1px solid var(--border, #eee)",
          borderInlineStart: "3px solid var(--coral, #E8725C)"
        }}>
          <div style={{ fontSize: 13, color: "var(--muted, #888)", marginBottom: 4 }}>
            {t.expensesTotal} {period === "last_month" ? t.expensesLastMonth : t.expensesThisMonth}
          </div>
          {Object.entries(totals).map(([cur, data]) => (
            <div key={cur} style={{ fontSize: 22, fontWeight: 700, color: "var(--dark, #1E2D2D)" }}>
              {formatAmount(data.total, cur)}
              <span style={{ fontSize: 13, fontWeight: 400, color: "var(--muted, #888)", marginInlineStart: 8 }}>
                ({data.count} {t.expensesCount})
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Expense list */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--muted, #888)" }}>
          <p style={{ fontSize: 14 }}>{t.expensesEmpty}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {filtered.map(expense => (
            <div key={expense.id} style={{
              background: "var(--card-bg, #fff)", borderRadius: 10,
              padding: "12px 14px",
              border: "1px solid var(--border, #eee)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: "var(--dark, #1E2D2D)" }}>
                  {formatAmount(expense.amountMinor || expense.amount_minor, expense.currency)}
                </span>
                <span style={{ fontSize: 14, fontWeight: 500, color: "var(--warm, #4A5858)" }}>
                  {expense.category || expense.description}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted, #888)", marginTop: 4 }}>
                {expense.attribution === "joint"
                  ? t.expensesJoint
                  : expense.attribution === "household"
                  ? (expense.paidBy || expense.paid_by || "")
                    ? `${t.expensesPaidBy} ${expense.paidBy || expense.paid_by}`
                    : ""
                  : (expense.paidBy || expense.paid_by)
                    ? `${t.expensesPaidBy} ${expense.paidBy || expense.paid_by}`
                    : ""}
                {(expense.paidBy || expense.paid_by || expense.attribution === "joint") && " · "}
                {timeAgo(expense.occurredAt || expense.occurred_at, t)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* WhatsApp CTA */}
      <div style={{ textAlign: "center", marginTop: 16 }}>
        <a
          href="https://wa.me/972555175553"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block", padding: "10px 20px", borderRadius: 10,
            background: "var(--warm, #4A5858)", color: "#fff",
            fontSize: 14, fontWeight: 600, textDecoration: "none",
          }}
        >
          + {t.expensesAddViaWA}
        </a>
        <p style={{ fontSize: 11, color: "var(--muted, #888)", marginTop: 6 }}>{t.expensesEditHint}</p>
      </div>
    </div>
  );
}
```

**Step 4: Add tab to `App.jsx`**

At the top of `src/App.jsx`, add the import (after line 13):

```javascript
import ExpensesView from "./components/ExpensesView.jsx";
```

And import the icon (find the existing icon imports):

```javascript
import { ReceiptIcon } from "./components/Icons.jsx";
```

In the tab content section (around line 865, after the `week` tab), add:

```jsx
          {tab === "expenses" && (
            <ExpensesView expenses={expenses} t={t} loading={!dataLoaded} />
          )}
```

In the bottom nav (around line 887, after the `week` button and before `</div>`), add:

```jsx
          <button className={`nav-btn ${tab==="expenses"?"active":""}`} onClick={() => setTab("expenses")}>
            <span className="nav-icon"><ReceiptIcon size={20} /></span>
            <span className="nav-label">{t.navExpenses}</span>
          </button>
```

In the state declaration area, ensure `expenses` is part of the household data. Find where tasks/shopping/events are destructured from `loadHousehold` result and add `expenses`:

```javascript
// Where household data is set (search for setTasks, setShopping, setEvents):
const expenses = hh.expenses || [];
// Add state: const [expenses, setExpenses] = useState([]);
// Set in the data loading: setExpenses(hh.expenses || []);
```

Also add a Realtime subscription for the expenses channel (around where other channels are set up):

```javascript
const expenseChannel = supabase.channel(`expenses:${hhId}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `household_id=eq.${hhId}` },
      () => loadExpenses(hhId).then(setExpenses))
  .subscribe();
```

And clean it up in the effect return: `supabase.removeChannel(expenseChannel);`

**Step 5: Commit**

```bash
git add src/components/ExpensesView.jsx src/components/Icons.jsx src/locales/he.js src/locales/en.js src/App.jsx
git commit -m "feat(expenses): add ExpensesView component, nav tab, locale strings"
```

---

### Task 11: Integration Tests — Expense Classifier + DB Verification

**Files:**
- Modify: `tests/test_webhook.py` (add ~8 new test cases)

**Step 1: Add expense test cases**

At the end of the test cases list in `test_webhook.py`, add:

```python
    # ─── Expenses ───
    {
        "name": "expense_speaker_ils",
        "text": "שילמתי 1300 חשמל",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "add_expense",
        "reply_pattern": r"רשמתי.*1,?300.*חשמל",
        "db_check": {"table": "expenses", "field": "amount_minor", "value": 130000},
    },
    {
        "name": "expense_named_attribution",
        "text": "אבא שילם 500 סופר",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "add_expense",
        "reply_pattern": r"רשמתי.*500.*סופר",
        "db_check": {"table": "expenses", "field": "attribution", "value": "named"},
    },
    {
        "name": "expense_joint",
        "text": "שילמנו 2400 ארנונה",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "add_expense",
        "reply_pattern": r"רשמתי.*2,?400.*ארנונה",
        "db_check": {"table": "expenses", "field": "attribution", "value": "joint"},
    },
    {
        "name": "expense_eur_currency",
        "text": "שילמתי 150 יורו דלק",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "add_expense",
        "reply_pattern": r"רשמתי.*150.*€|EUR",
        "db_check": {"table": "expenses", "field": "currency", "value": "EUR"},
    },
    {
        "name": "expense_negative_treating",
        "text": "שילמתי עליו 50 בבית קפה",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "ignore",
    },
    {
        "name": "expense_negative_task",
        "text": "לשלם חשמל",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "add_task",
    },
    {
        "name": "expense_query_summary",
        "text": "שלי כמה שילמנו החודש?",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "query_expense",
        "reply_pattern": r"(סה.כ|הוצאות|₪|עדיין לא)",
    },
    {
        "name": "expense_paid_him_valid",
        "text": "שילמתי לו 500 לעבודה שעשה",
        "chat_id": TEST_GROUP_CHAT_ID,
        "expected_intent": "add_expense",
        "reply_pattern": r"רשמתי.*500",
    },
```

**Step 2: Add `expenses` table to DB check logic**

Find the `db_check` handler in `test_webhook.py` (around line 660-700). It currently checks tasks/shopping_items/events tables. Add:

```python
elif check["table"] == "expenses":
    rows = sb.table("expenses") \
        .select("*") \
        .eq("household_id", household_id) \
        .eq("deleted", False) \
        .order("created_at", desc=True) \
        .limit(1) \
        .execute()
    if rows.data and rows.data[0].get(check["field"]) == check["value"]:
        results["db_check"] = "PASS"
    else:
        results["db_check"] = f"FAIL: expected {check['field']}={check['value']}, got {rows.data[0] if rows.data else 'no rows'}"
```

Also add cleanup at the end of each expense test — delete test expenses:

```python
# In the test cleanup section:
sb.table("expenses").delete().eq("household_id", household_id).execute()
```

**Step 3: Run tests (after enabling the feature)**

Set `EXPENSES_ENABLED=true` in Supabase Dashboard → Edge Function → whatsapp-webhook → Secrets. Then:

```bash
python tests/test_webhook.py
```

Expected: all 8 new expense tests pass (allow ~6% LLM flakiness).

**Step 4: Commit**

```bash
git add tests/test_webhook.py
git commit -m "test(expenses): add 8 integration tests for expense intents"
```

---

### Task 12: Enable for Beta + Verify E2E

**Step 1: Enable feature flag**

In Supabase Dashboard → Edge Function → whatsapp-webhook → Environment Variables:
- Set `EXPENSES_ENABLED=true`

**Step 2: Manual E2E test in own household**

Send these messages to Sheli in a WhatsApp group:
1. `שילמתי 100 חשמל` → expect confirmation
2. `שילמנו 250 סופר` → expect joint confirmation
3. `כמה שילמנו החודש?` → expect summary with both expenses
4. `בטלי` → expect undo of last expense
5. Open web app → Expenses tab → verify list shows remaining expenses

**Step 3: Run integration tests**

```bash
python tests/test_webhook.py
```

**Step 4: Enable for Kaye family**

Feature flag is global (`EXPENSES_ENABLED=true`), so all households get it. Announce to Adi Kaye via 1:1: "שלי יודעת עכשיו לרשום הוצאות! 💰 נסי: 'שילמתי X על Y'"

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "feat(expenses): enable for beta, verified E2E"
```

---

### Task 13: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (ours-app)

**Step 1: Add expenses to key sections**

Add to the "Database: Normalized V2 Tables" section:
```
- `expenses` — Household expense tracking. Fields: `id`, `household_id` (FK CASCADE), `amount_minor` (integer, minor currency units), `currency` (ILS/USD/EUR/GBP), `description`, `category`, `paid_by`, `attribution` (speaker/named/joint/household), `occurred_at`, `visibility` (household/private), `source`, `source_message_id`, `deleted`, `deleted_at`. RLS enabled, `is_household_member`. Realtime enabled.
```

Add to the "13 Intent Types" table:
```
| `add_expense` | Log a payment | INSERT expenses |
| `query_expense` | Answer spend question | Aggregate expenses + Sonnet reply |
```

Add to the classification values:
```
`haiku_expense`, `haiku_expense_query`
```

Add to WhatsApp Bot Gotchas:
```
- **Expense "שילמתי עליו" ≠ "שילמתי לו"** — "עליו" (treating someone) = ignore. "לו" (direct payment) = add_expense. Neither is add_task.
- **Multi-currency expenses** — default ILS for Hebrew speakers. Explicit "יורו"/"דולר"/"€"/"$" overrides. Never sum across currencies in queries or web view.
- **1:1 expense privacy** — first expense in 1:1 triggers visibility preference prompt (household vs private). Stored in household_patterns.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with expenses feature reference"
```
