# Expenses Feature — Design v0

**Date:** 2026-04-16
**Status:** Approved
**Origin:** Adi Kaye (beta user) request + PM friend validation
**Scope:** WhatsApp-first expense logging, query, read-only web view

---

## Problem

Israeli families track household expenses informally in WhatsApp groups ("שילמתי 1300 חשמל") but have no structured memory. Existing apps (Splitwise, Riseup) are overkill for couples/families — too complex, separate context. No family-coordination app (Cozi, Any.do) offers this.

Sheli solves three problems simultaneously:
1. **Fairness ledger** — who paid what, over time
2. **Historical memory** — how much was electricity last summer?
3. **Shared awareness** — both partners see what's going out

## Decision

Build a **deliberately minimal v0**: capture expenses from WhatsApp chat, answer two free-tier query types, show a read-only web list. No categories UI, no charts, no OCR, no split-math.

Validate with beta families (Kaye first — she requested it). Measure adoption + query engagement before scoping Phase 2.

---

## Architecture

Same pipeline as tasks/shopping/events — no new infrastructure:

```
WhatsApp message
  -> Haiku classifier -> intent=add_expense | query_expense | ignore
  -> add_expense  -> action-executor INSERT -> Sonnet confirms
  -> query_expense -> Supabase aggregate -> Sonnet replies with summary
  -> Realtime -> Web app Expenses tab (read-only list)
```

**Reuses:** Haiku->Sonnet pipeline, 60s quick-undo, correct_bot flow, member resolution (whatsapp_member_mapping + household_patterns nicknames), Realtime subscriptions, RLS policy pattern.

**New:** 1 table, 2 intents, 1 action type, 1 web component, supabase.js helpers, prompt additions.

---

## Data Model

### `expenses` table

```sql
CREATE TABLE public.expenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id      UUID NOT NULL REFERENCES households_v2(id) ON DELETE CASCADE,

  -- Money (stored in minor currency units to avoid float errors)
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  currency          TEXT NOT NULL DEFAULT 'ILS',

  -- What
  description       TEXT NOT NULL,
  category          TEXT,                  -- Sheli-inferred, free-text

  -- Who paid
  paid_by           TEXT,                  -- member display_name (nullable for household/anonymous)
  attribution       TEXT NOT NULL
                    CHECK (attribution IN ('speaker','named','joint','household')),

  -- When
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Privacy (1:1 vs group)
  visibility        TEXT NOT NULL DEFAULT 'household'
                    CHECK (visibility IN ('household','private')),

  -- Provenance
  source            TEXT NOT NULL DEFAULT 'whatsapp',
  source_message_id TEXT,
  logged_by_phone   TEXT,

  -- Soft delete
  edited            BOOLEAN NOT NULL DEFAULT false,
  deleted           BOOLEAN NOT NULL DEFAULT false,
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_expenses_household_occurred
  ON expenses(household_id, occurred_at DESC) WHERE deleted = false;
CREATE INDEX idx_expenses_household_category
  ON expenses(household_id, category) WHERE deleted = false;
CREATE INDEX idx_expenses_household_currency
  ON expenses(household_id, currency) WHERE deleted = false;
CREATE INDEX idx_expenses_source_message
  ON expenses(source_message_id) WHERE source_message_id IS NOT NULL;
```

### RLS policies

```sql
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
```

Upsert-safe: INSERT and UPDATE use the same check.

### Realtime

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;
```

### Key design decisions

- **`amount_minor INTEGER`** — not NUMERIC/DECIMAL. 1,300.50 ILS = 130050. Avoids float rounding on aggregation. Minor unit divisor (100 for ILS/USD/EUR/GBP, 1 for JPY) is a hardcoded lookup, not per-row.
- **`currency` active, not decorative** — multi-currency from day one. Default ILS for Hebrew speakers.
- **`visibility`** — per-row, not per-user. Same person may want some expenses private, others shared.
- **Soft delete forever** — money audit trail. `deleted=true` stays in DB permanently. No cleanup cron.
- **`occurred_at` vs `created_at`** — supports backdating ("שילמתי אתמול").

---

## Multi-Currency

### Default: ILS for Hebrew speakers

Users say "שילמתי 1300 חשמל" -> currency=ILS (no annotation needed).

### Explicit currency signals

```
"150 יורו" / "150 euro" / "€150"    -> EUR
"50 דולר" / "$50" / "50 dollars"     -> USD
"30 פאונד" / "£30"                   -> GBP
```

### Separation rules

- **Never sum across currencies.** Summary queries return per-currency blocks.
- Web view groups expenses by currency. Summary card shows per-currency totals.
- Query response format: "באפריל: 4,280 ₪ (12 הוצאות) + 340 € (3 הוצאות)."

### Smart default (Phase 2, not v0)

After 5+ expenses in a non-default currency, Sheli asks in 1:1: "שמתי לב שרוב ההוצאות שלכם ביורו. להחליף את ברירת המחדל?". Stored in `household_patterns` as `default_currency`.

---

## 1:1 Privacy Model

### Problem

1:1 is the private PA space. Users may want secret expenses (surprise gifts, private purchases). Money is more sensitive than tasks.

### Design

- **Group message** -> `visibility = 'household'` always
- **1:1 message** -> Sheli asks on **first expense per household**:

```
שלי: רשמתי! 💰 שאלה קטנה —
     הוצאות שתרשמו פה ב-1:1, להוסיף ליומן המשפחתי, או לשמור רק בינינו?
     1 - למשפחה (כולם רואים)
     2 - רק בינינו (פרטי)
```

Stored in `household_patterns` as `expense_1on1_visibility: 'household' | 'private'`.

### Per-message override

"שילמתי 300 מתנה ליעל, תשמרי רק בינינו" -> `visibility = 'private'` regardless of default.

### Visibility rules

| Context | Sees private? |
|---------|--------------|
| Group query ("כמה שילמנו החודש?") | No |
| 1:1 query ("כמה שילמתי החודש?") | Yes (own private only) |
| Web app Expenses tab | No (Phase 2: toggle with auth confirmation) |

---

## Classifier Changes

### Two new intents

| Intent | Purpose | Routing |
|--------|---------|---------|
| `add_expense` | Log a payment | >=0.70 execute, 0.50-0.69 escalate |
| `query_expense` | Answer a spend question | Same tiers |

### `add_expense` entities

```json
{
  "intent": "add_expense",
  "confidence": 0.93,
  "entities": {
    "amount_text": "1300",
    "amount_minor": 130000,
    "currency": "ILS",
    "description": "חשמל",
    "category": "חשמל",
    "attribution": "speaker",
    "paid_by_name": null,
    "occurred_at_hint": null,
    "visibility_hint": null
  }
}
```

### `query_expense` entities

```json
{
  "intent": "query_expense",
  "confidence": 0.88,
  "entities": {
    "query_type": "summary",
    "category": null,
    "period": "this_month",
    "period_start_iso": "2026-04-01T00:00:00+03:00",
    "period_end_iso": "2026-04-30T23:59:59+03:00"
  }
}
```

### v0 query types (free tier)

1. **Monthly summary** — "תסכמי לנו את ההוצאות החודש / בחודש שעבר"
2. **Category in period** — "כמה שילמנו חשמל החודש?"

### Future premium query types

- Historical comparison ("כמה שילמנו חשמל בקיץ שעבר?")
- Last-payment lookup ("מי שילם את החשמל הפעם?")
- Proactive monthly summary (Sheli sends unprompted roundup)

### Haiku prompt examples

```
// Positive — 4 attribution modes
"שילמתי 1300 חשמל" -> add_expense, attribution=speaker, description="חשמל", amount=1300, currency=ILS
"אבא שילם 500 סופר" -> add_expense, attribution=named, paid_by_name="אבא", amount=500
"שילמנו 2400 ארנונה" -> add_expense, attribution=joint, amount=2400
"שולם 180 ביטוח" -> add_expense, attribution=household, amount=180
"יעל שילמה 4200 גן" -> add_expense, attribution=named, paid_by_name="יעל", amount=4200

// Multi-currency
"שילמתי 150 יורו דלק" -> add_expense, currency=EUR, amount=150
"paid $50 for gas" -> add_expense, currency=USD, amount=50

// Queries
"כמה שילמנו החודש?" -> query_expense, query_type=summary, period=this_month
"תסכמי לנו את ההוצאות בחודש שעבר" -> query_expense, query_type=summary, period=last_month
"כמה שילמנו חשמל החודש?" -> query_expense, query_type=category_in_period, category=חשמל

// Negative examples (NOT expenses)
"שילמתי עליו 50 בבית קפה" -> ignore (social/treating, not household expense)
"תקני לי חלב ב-12 שקל" -> add_shopping (shopping context, not expense)
"המשכנתא עולה 4000 בחודש" -> ignore (price statement, not payment event)
"שילמתי בפה" -> ignore (slang, no money)
```

### Hebrew-specific guards

- "שילמתי לו X" (paid him) = expense. "שילמתי עליו X" (paid for him) = ignore (social treating). Neither is a task.
- Amount without payment verb is not expense: "העלות 500" = ignore.
- Amount bounds: 0.50 - 1,000,000 in major currency. Outside -> clarify, don't insert.

### Amount parsing

TypeScript `parseAmount()` helper, NOT Haiku-only:
- Handles: "1,300", "1.3K", "₪1300", "1300 ש״ח", "אלף ושלוש מאות"
- Cross-validates Haiku's `amount_minor` vs parsed `amount_text`. If disagree >10% -> ask user.

---

## Action Executor

### `add_expense`

```typescript
async function executeAddExpense(action, ctx) {
  const amount_minor = parseAmountToMinor(action.entities);
  if (!amount_minor || amount_minor < 50 || amount_minor > 100_000_000) {
    return { status: 'clarify', reason: 'amount_suspicious' };
  }

  const paid_by = resolveAttribution(action.entities, ctx);

  await supabase.from('expenses').insert({
    household_id: ctx.household_id,
    amount_minor,
    currency: action.entities.currency || 'ILS',
    description: action.entities.description,
    category: action.entities.category || action.entities.description,
    paid_by,
    attribution: action.entities.attribution,
    occurred_at: action.entities.occurred_at_hint || new Date().toISOString(),
    visibility: resolveVisibility(action.entities, ctx),
    source: ctx.isVoice ? 'voice' : 'whatsapp',
    source_message_id: ctx.messageId,
    logged_by_phone: ctx.senderPhone
  });

  return { status: 'ok', summary: { amount, currency, category, paid_by } };
}
```

### `query_expense`

Aggregate query per-currency. Never sum across currencies. Return structured data for Sonnet to format.

---

## Sonnet Reply Templates

### Expense confirmation

```
"רשמתי — 1,300 ₪ חשמל על חשבונך ✓"
"רשמתי — 500 ₪ סופר, מי שילם: אבא ✓"
"רשמתי — 2,400 ₪ ארנונה, שילמתם ביחד ✓"
"רשמתי — 150 € דלק על חשבונך ✓"
```

If amount >1000 or new category: "רשמתי — 12,000 ₪ דירה 💸 שמרתי בהיסטוריה."

### Query summary

```
"באפריל: סה״כ 4,280 ₪ על פני 12 הוצאות.
 הכי גדולות: חשמל (1,300 ₪), ארנונה (1,200 ₪), סופר (850 ₪)."
```

Multi-currency:
```
"באפריל: 4,280 ₪ (12 הוצאות) + 340 € (3 הוצאות)."
```

Category query:
```
"חשמל באפריל: 1,300 ₪ (תשלום אחד)."
```

Zero state:
```
"עדיין לא רשמנו הוצאות באפריל. ספרו לי כשמשלמים — 'שילמתי X על Y'."
```

CRITICAL: Never fabricate totals.

---

## Edit / Undo Flow

### Quick undo (60s window)

"לא נכון" / "תמחקי" / "בטלי" within 60s -> instant soft-delete. Reuses existing quick-undo infrastructure.

### Reply-to-message correction

User replies to Sheli's confirmation message ("רשמתי — 1,300 ₪ חשמל") with "לא, 130".
- WhatsApp payload includes `quoted_message_id`
- Lookup `source_message_id` -> find exact expense
- Update amount

### Classifier-driven correction (after 60s)

"תתקני את החשמל ל-130" -> `correct_bot` intent -> find latest matching expense by category + edit.

---

## Web Surface

### ExpensesTab.jsx (read-only)

5th tab in nav (after Events, before Rotations). Receipt icon.

```
┌─────────────────────────────────────┐
│ הוצאות                              │
├─────────────────────────────────────┤
│ [החודש ▾]  [כל הקטגוריות ▾]        │
├─────────────────────────────────────┤
│ סה״כ החודש                          │
│   4,280 ₪   (12 הוצאות)             │
│   340 €     (3 הוצאות)              │
├─────────────────────────────────────┤
│ 1,300 ₪  חשמל                       │
│   מי שילם: יעל · היום 14:30         │
├─────────────────────────────────────┤
│ 450 ₪   סופר                        │
│   מי שילם: אבא · אתמול              │
├─────────────────────────────────────┤
│ 180 ₪   ביטוח                       │
│   משותף · לפני יומיים                │
└─────────────────────────────────────┘
         [ + הוסיפו בווטסאפ ]
```

Non-tap hint: "לעריכה, כתבו לשלי בווטסאפ"

### Filters

- Period: this_month | last_month | all_time
- Category: all | <observed categories>
- Read-only: no add/edit/delete in web. Future Phase 3.

### Private expenses

Not shown in web v0. Phase 2: optional toggle with re-auth.

### Realtime

6th channel. 3-second echo-debounce pattern.

### Analytics events

- `expenses_tab_viewed` (expense_count)
- `expenses_filter_changed` (period, category)

---

## Landing Page (Phase 2 — after beta observation)

Additions when shipping:
- Feature bullet: HE "הוצאות משפחתיות" / EN "Family expenses"
- WhatsApp mock showing expense logging + query
- Privacy FAQ entry about expense data
- Feature list update: "מטלות · קניות · אירועים · הוצאות · תזכורות"

---

## Testing

### Classifier fixtures (~20 new cases)

- 8 `add_expense` positive (4 attribution modes x 2 phrasings)
- 4 `query_expense` positive (2 query_types x 2 periods)
- 2 multi-currency (EUR, USD)
- 5 negatives ("שילמתי עליו", "העלות 500", shopping-not-expense, etc.)
- 3 Hebrew number edge cases

### Integration tests (~8 new cases in test_webhook.py)

- Each attribution mode -> verify DB row
- Multi-currency -> verify currency field
- Query -> verify Sonnet reply aggregate
- Reply-to-message edit -> verify source_message_id lookup
- Quick-undo -> verify soft-delete
- Bounds check -> clarify, don't insert

### Manual smoke test

Week 1: Kaye family (Adi requested). Observe misclassifications, correction rate, query patterns.

---

## Cost

### AI cost per household

- ~15 expenses/month + ~3 queries/month
- Add-expense: Haiku ($0.0003) + Sonnet ($0.008) = ~$0.008/event
- Query: Haiku + Sonnet = ~$0.009/query
- **Total: ~$0.15/household/month** (fits in existing $0.50 budget)

### Storage

- 15 expenses x 12 months x ~200 bytes = 36 KB/household/year. Negligible.

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Amount misclassified 10x | High | Bounds check, confirm >1K first-time, quick-undo, reply-to-edit |
| Non-payment logged as expense | Medium | Negative examples, Sonnet escalation |
| "500 סופר ודלק" compound | Medium | Log as single in v0, document |
| Cross-currency summing | Medium | Never sum across currencies, per-currency display |
| Privacy leak (private expense in group) | High | visibility column, WHERE filter on all group queries |
| Hebrew number parsing failure | Low | parseAmount() with fallback, ask "איזה סכום?" |

---

## Rollout

### Phase 1 — Beta (week 1)

- Deploy: DB migration, classifier, action executor, web tab
- `EXPENSES_ENABLED` env var, off by default
- Enable for: Kaye family, own household
- Observe 5-7 days

### Phase 2 — All beta families (week 2)

- Remove feature flag
- Landing page updates
- Announce in 1:1 DMs

### Phase 3 — Premium gate (week 4+)

- Review usage
- Gate comparison + proactive behind Premium if adopted
- Cut if not adopted

---

## Success Metrics

1. **Adoption:** >=50% active households log >=3 expenses in month 1
2. **Query engagement:** >=30% of logging households queried at least once
3. **Quality:** <5% correct_bot rate on expense intents
4. **Premium signal:** >=2 households request comparison queries in month 2

All 4 hit -> Phase 2 features. <2 hit -> stay v0 or cut.

---

## Scope Boundaries (NOT in v0)

- OCR / invoice image upload
- Recurring bill detection
- Charts / budgets / forecasts
- Split-math / settle-up / who-owes-who
- Full web CRUD
- Comparison queries ("last summer")
- Proactive monthly summary
- Private expenses in web view
- Smart default currency detection
