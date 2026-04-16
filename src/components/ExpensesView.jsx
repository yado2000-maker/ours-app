import { useState, useMemo } from "react";

const CURRENCY_SYMBOL = { ILS: "\u20AA", USD: "$", EUR: "\u20AC", GBP: "\u00A3" };
const MINOR_UNIT = { ILS: 100, USD: 100, EUR: 100, GBP: 100, JPY: 1 };

function formatAmount(amountMinor, currency) {
  const unit = MINOR_UNIT[currency] || 100;
  const sym = CURRENCY_SYMBOL[currency] || currency;
  const val = (amountMinor / unit).toLocaleString("he-IL");
  return `${sym}${val}`;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "\u05E2\u05DB\u05E9\u05D9\u05D5";
  if (mins < 60) return `\u05DC\u05E4\u05E0\u05D9 ${mins} \u05D3\u05E7\u05F3`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `\u05DC\u05E4\u05E0\u05D9 ${hours} \u05E9\u05E2\u05F3`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "\u05D0\u05EA\u05DE\u05D5\u05DC";
  return `\u05DC\u05E4\u05E0\u05D9 ${days} \u05D9\u05DE\u05D9\u05DD`;
}

export default function ExpensesView({ expenses = [], t, loading, onPeriodChange }) {
  const [period, setPeriod] = useState("this_month");
  const [categoryFilter, setCategoryFilter] = useState("all");

  // Client-side category filter (period filtering is server-side via onPeriodChange)
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
      const amount = e.amountMinor || 0;
      if (!byCurrency[cur]) byCurrency[cur] = { total: 0, count: 0 };
      byCurrency[cur].total += amount;
      byCurrency[cur].count++;
    }
    return byCurrency;
  }, [filtered]);

  const handlePeriodChange = (newPeriod) => {
    setPeriod(newPeriod);
    setCategoryFilter("all");
    if (onPeriodChange) onPeriodChange(newPeriod);
  };

  if (loading) return <div className="tab-loading" style={{ textAlign: "center", padding: 40, color: "var(--muted, #888)" }}>...</div>;

  const periodLabel = period === "last_month" ? t.expensesLastMonth
    : period === "all_time" ? t.expensesAllTime
    : t.expensesThisMonth;

  return (
    <div style={{ padding: "12px 16px" }}>
      {/* Filter row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select
          value={period}
          onChange={e => handlePeriodChange(e.target.value)}
          style={{
            flex: 1, padding: "6px 10px", borderRadius: 8,
            border: "1px solid var(--border, #ddd)", background: "var(--card-bg, #fff)",
            fontSize: 14, color: "var(--dark, #1E2D2D)",
          }}
        >
          <option value="this_month">{t.expensesThisMonth}</option>
          <option value="last_month">{t.expensesLastMonth}</option>
          <option value="all_time">{t.expensesAllTime}</option>
        </select>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{
            flex: 1, padding: "6px 10px", borderRadius: 8,
            border: "1px solid var(--border, #ddd)", background: "var(--card-bg, #fff)",
            fontSize: 14, color: "var(--dark, #1E2D2D)",
          }}
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
          borderInlineStart: "3px solid var(--coral, #E8725C)",
        }}>
          <div style={{ fontSize: 13, color: "var(--muted, #888)", marginBottom: 4 }}>
            {t.expensesTotal} {periodLabel}
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
          <p style={{ fontSize: 14, lineHeight: 1.6 }}>{t.expensesEmpty}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {filtered.map(expense => {
            const amount = expense.amountMinor || 0;
            const paidBy = expense.paidBy || null;
            const occurred = expense.occurredAt || expense.created_at;

            // Build attribution line
            let attrText = "";
            if (expense.attribution === "joint") {
              attrText = t.expensesJoint;
            } else if (paidBy) {
              attrText = `${t.expensesPaidBy} ${paidBy}`;
            }
            // household with no paidBy — omit attribution

            return (
              <div key={expense.id} style={{
                background: "var(--card-bg, #fff)", borderRadius: 10,
                padding: "12px 14px",
                border: "1px solid var(--border, #eee)",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "var(--dark, #1E2D2D)" }}>
                    {formatAmount(amount, expense.currency)}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 500, color: "var(--warm, #4A5858)" }}>
                    {expense.category || expense.description}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted, #888)", marginTop: 4 }}>
                  {attrText}
                  {attrText && occurred ? " \u00B7 " : ""}
                  {occurred ? timeAgo(occurred) : ""}
                </div>
              </div>
            );
          })}
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
