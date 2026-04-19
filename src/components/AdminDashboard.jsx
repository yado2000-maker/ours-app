import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabase.js";

const ADMIN_IDS = ["28daa344-ad5a-449b-8e36-f6296bb2f51c", "9698d5df-e40e-4f2b-a91e-a911f14fe1c8", "dc552ffd-65f5-4943-a64a-8f6d56c8578a"];
const REFRESH_INTERVAL = 60000;

// Override html/body overflow:hidden from app.css so admin dashboard can scroll
function useBodyScroll() {
  useEffect(() => {
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
    return () => {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    };
  }, []);
}

const INTENT_COLORS = {
  add_shopping: "#2AB673",
  add_task: "#E8725C",
  add_event: "#5B8DEF",
  complete_task: "#F5A623",
  complete_shopping: "#9B59B6",
  question: "#3DC882",
  add_reminder: "#E67E22",
  claim_task: "#1ABC9C",
  info_request: "#95A5A6",
  correct_bot: "#E74C3C",
  instruct_bot: "#3498DB",
  other: "#8A9494",
};

const FUNNEL_STEPS = ["welcomed", "chatting", "invited", "joined", "personal", "nudging", "sleeping", "dormant"];
const FUNNEL_COLORS = ["#3DC882", "#2AB673", "#5B8DEF", "#1E9E5E", "#17804B", "#F5A623", "#E8725C", "#95A5A6"];
const FUNNEL_LABELS = {
  welcomed: "Welcomed", chatting: "Chatting", invited: "Invited",
  joined: "Joined", personal: "Personal Channel",
  nudging: "Nudging", sleeping: "Sleeping", dormant: "Dormant",
};

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

// ── Helpers ──

function relativeTime(dateStr) {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function fmtHour(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function fmtTime(date) {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function pct(a, b) {
  if (!b) return "0%";
  return `${Math.round((a / b) * 100)}%`;
}

// ── Sparkline SVG ──

function Sparkline({ data = [], width = "100%", height = 120, color = "var(--accent)", fillOpacity = 0.1, labels = [], secondData = null, secondColor = "var(--primary)" }) {
  if (!data.length) return <svg width={width} height={height} />;

  const pad = { top: 12, bottom: labels.length ? 22 : 8, left: 8, right: 8 };
  const viewW = 500;
  const viewH = height;
  const chartW = viewW - pad.left - pad.right;
  const chartH = viewH - pad.top - pad.bottom;

  const allVals = secondData ? [...data, ...secondData] : data;
  const maxVal = Math.max(...allVals, 1);
  const minVal = Math.min(...allVals, 0);
  const range = maxVal - minVal || 1;
  const yPad = range * 0.1;

  const toX = (i) => pad.left + (i / Math.max(data.length - 1, 1)) * chartW;
  const toY = (v) => pad.top + chartH - ((v - minVal + yPad) / (range + yPad * 2)) * chartH;

  const makeLine = (vals) => vals.map((v, i) => `${toX(i)},${toY(v)}`).join(" ");
  const makeFill = (vals) => {
    const baseline = toY(minVal);
    return `${toX(0)},${baseline} ${vals.map((v, i) => `${toX(i)},${toY(v)}`).join(" ")} ${toX(vals.length - 1)},${baseline}`;
  };

  return (
    <svg width={width} height={viewH} viewBox={`0 0 ${viewW} ${viewH}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={pad.left} x2={viewW - pad.right} y1={pad.top + chartH * (1 - f)} y2={pad.top + chartH * (1 - f)} stroke="var(--border)" strokeWidth="0.5" />
      ))}

      {/* Second data (behind) */}
      {secondData && (
        <>
          <polygon points={makeFill(secondData)} fill={secondColor} opacity={fillOpacity} />
          <polyline points={makeLine(secondData)} fill="none" stroke={secondColor} strokeWidth="2" />
        </>
      )}

      {/* Primary data */}
      <polygon points={makeFill(data)} fill={color} opacity={fillOpacity} />
      <polyline points={makeLine(data)} fill="none" stroke={color} strokeWidth="2" />

      {/* Dots */}
      {data.map((v, i) => (
        <circle key={i} cx={toX(i)} cy={toY(v)} r="3" fill={color} />
      ))}

      {/* Labels */}
      {labels.map((label, i) => {
        const skip = labels.length > 16 ? 3 : labels.length > 10 ? 2 : 1;
        if (i % skip !== 0) return null;
        return (
          <text key={i} x={toX(i)} y={viewH - 2} textAnchor="middle" fontSize="11" fill="var(--muted)" fontFamily="Nunito, sans-serif">
            {label}
          </text>
        );
      })}
    </svg>
  );
}

// ── Donut Chart (CSS conic-gradient) ──

function DonutChart({ data, size = 200, centerLabel = "actions" }) {
  // Polymorphic: accept legacy {key:value} object OR [{label,value,color}] array
  const normalized = Array.isArray(data)
    ? data.map((d, i) => ({ key: d.label || String(i), label: d.label, value: d.value, color: d.color }))
    : Object.entries(data)
        .filter(([k]) => k !== "ignore")
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => ({ key, label: key.replace(/_/g, " "), value, color: INTENT_COLORS[key] || INTENT_COLORS.other }));

  const total = normalized.reduce((sum, n) => sum + n.value, 0);
  if (!total) return <div style={{ width: size, height: size, borderRadius: "50%", background: "var(--border)" }} />;

  let cumPct = 0;
  const stops = normalized.map((n) => {
    const startPct = cumPct;
    cumPct += (n.value / total) * 100;
    return `${n.color} ${startPct}% ${cumPct}%`;
  });

  const gradient = `conic-gradient(${stops.join(", ")})`;

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{
        width: size, height: size, borderRadius: "50%", background: gradient, position: "relative", flexShrink: 0,
      }}>
        <div style={{
          position: "absolute", top: "25%", left: "25%", width: "50%", height: "50%",
          borderRadius: "50%", background: "var(--white)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column",
        }}>
          <span style={{ fontSize: 22, fontWeight: 800, color: "var(--dark)" }}>{total}</span>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{centerLabel}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {normalized.map((n) => (
          <div key={n.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{
              width: 12, height: 12, borderRadius: 3, flexShrink: 0,
              background: n.color,
            }} />
            <span style={{ color: "var(--dark)", fontWeight: 600 }}>{n.label}</span>
            <span style={{ color: "var(--muted)" }}>{n.value} ({pct(n.value, total)})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Stat Card ──

function StatCard({ label, value, sub, color = "var(--dark)", small = false }) {
  return (
    <div style={{
      background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
      padding: small ? "14px 16px" : "20px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: small ? 24 : 36, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: "var(--muted)" }}>{sub}</span>}
    </div>
  );
}

// ── Section Wrapper ──

function Section({ title, subtitle, children }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--dark)", margin: 0 }}>{title}</h2>
        {subtitle && <p style={{ fontSize: 13, color: "var(--muted)", margin: "2px 0 0" }}>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// ── Table ──

function DataTable({ columns, rows, emptyMsg = "No data" }) {
  if (!rows || !rows.length) {
    return <p style={{ fontSize: 13, color: "var(--muted)", padding: "12px 0" }}>{emptyMsg}</p>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, fontFamily: "'Nunito', sans-serif" }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{
                textAlign: "left", padding: "8px 10px", borderBottom: "2px solid var(--border)",
                color: "var(--muted)", fontWeight: 600, fontSize: 12, whiteSpace: "nowrap",
              }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {columns.map((col) => (
                <td key={col.key} style={{
                  padding: "8px 10px", borderBottom: "1px solid var(--border)",
                  color: "var(--dark)", whiteSpace: "nowrap",
                }}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Component ──

export default function AdminDashboard({ session, onBack }) {
  useBodyScroll();
  const [overview, setOverview] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [features, setFeatures] = useState(null);
  const [channelStats, setChannelStats] = useState(null);
  const [waitlistStats, setWaitlistStats] = useState(null);
  const [waitlistError, setWaitlistError] = useState(null);
  const [period, setPeriod] = useState(7);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const intervalRef = useRef(null);

  const isAdmin = ADMIN_IDS.includes(session?.user?.id);

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const [overviewRes, funnelRes, featuresRes, chRes, wlRes] = await Promise.all([
        supabase.rpc("admin_dashboard_overview", { p_days: period }),
        supabase.rpc("admin_funnel_stats"),
        supabase.rpc("admin_feature_stats", { p_days: period }),
        supabase.rpc("admin_channel_stats", { p_days: period }),
        supabase.rpc("admin_waitlist_stats", { p_days: period }),
      ]);

      if (overviewRes.error) throw new Error(`Overview: ${overviewRes.error.message}`);
      if (funnelRes.error) throw new Error(`Funnel: ${funnelRes.error.message}`);
      if (featuresRes.error) throw new Error(`Features: ${featuresRes.error.message}`);
      if (chRes.error) throw new Error(`Channels: ${chRes.error.message}`);
      // Waitlist is non-fatal — migration may not be applied yet. Degrade gracefully.
      if (wlRes.error) {
        console.warn("[AdminDashboard] waitlist RPC unavailable:", wlRes.error.message);
        setWaitlistError(wlRes.error.message);
      } else {
        setWaitlistError(null);
      }

      // Check for empty response (non-admin RLS)
      const ov = overviewRes.data;
      const fn = funnelRes.data;
      const ft = featuresRes.data;

      if (!ov || (typeof ov === "object" && !("period_days" in ov))) {
        setError("Access denied. RPC returned empty data.");
        return;
      }

      setOverview(ov);
      setFunnel(fn);
      setFeatures(ft);
      setChannelStats(chRes.data || null);
      setWaitlistStats(wlRes.data || null);
      setLastRefresh(new Date());
    } catch (err) {
      console.error("[AdminDashboard] fetch error:", err);
      setError(err.message || "Failed to fetch data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchAll();
  }, [fetchAll, isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    intervalRef.current = setInterval(() => fetchAll(true), REFRESH_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchAll, isAdmin]);

  // ── Not authorized ──
  if (!isAdmin) {
    return (
      <div style={{
        fontFamily: "'Nunito', sans-serif", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", height: "100dvh",
        background: "var(--cream)", color: "var(--dark)", gap: 16, padding: 24,
      }}>
        <div style={{ fontSize: 48 }}>&#128274;</div>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Not authorized</h1>
        <p style={{ color: "var(--muted)", fontSize: 14 }}>You don't have admin access.</p>
        <button onClick={onBack} style={btnStyle}>Back to app</button>
      </div>
    );
  }

  // ── Loading ──
  if (loading && !overview) {
    return (
      <div style={{
        fontFamily: "'Nunito', sans-serif", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", height: "100dvh",
        background: "var(--cream)", color: "var(--dark)", gap: 16,
      }}>
        <div style={{ width: 40, height: 40, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "admSpin 0.8s linear infinite" }} />
        <p style={{ color: "var(--muted)", fontSize: 14 }}>Loading dashboard...</p>
        <style>{`@keyframes admSpin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Error ──
  if (error && !overview) {
    return (
      <div style={{
        fontFamily: "'Nunito', sans-serif", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", height: "100dvh",
        background: "var(--cream)", color: "var(--dark)", gap: 16, padding: 24,
      }}>
        <div style={{ fontSize: 48 }}>&#9888;&#65039;</div>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Error</h1>
        <p style={{ color: "var(--muted)", fontSize: 14, textAlign: "center", maxWidth: 400 }}>{error}</p>
        <button onClick={() => fetchAll()} style={btnStyle}>Retry</button>
        <button onClick={onBack} style={{ ...btnStyle, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" }}>Back to app</button>
      </div>
    );
  }

  // ── Data helpers ──
  const ov = overview || {};
  const fn = funnel || {};
  const ft = features || {};

  const isHourly = period === 1 && ov.messages_by_hour;
  const msgSrc = isHourly ? (ov.messages_by_hour || []) : (ov.messages_by_day || []);
  const waData = msgSrc.map((d) => d.wa || 0);
  const webData = msgSrc.map((d) => d.web || 0);
  const msgLabels = isHourly
    ? msgSrc.map((d) => fmtHour(d.hour))
    : msgSrc.map((d) => fmtDate(d.day));

  const isHourlyTrend = period === 1 && ov.hourly_active_trend;
  const trendSrc = isHourlyTrend ? (ov.hourly_active_trend || []) : (ov.weekly_active_trend || []);
  const weekData = trendSrc.map((w) => w.count || 0);
  const weekLabels = isHourlyTrend
    ? trendSrc.map((w) => fmtHour(w.hour))
    : trendSrc.map((w) => fmtDate(w.week));

  const households = (ov.household_details || []).sort((a, b) => (b.wa_msgs + b.web_msgs) - (a.wa_msgs + a.web_msgs));

  const funnelCounts = fn.funnel_counts || {};
  const conversations = (fn.conversations || []).slice(0, 10);

  const intents = ft.intent_distribution || {};
  const aiCosts = ft.ai_costs || {};
  const dailyCosts = ft.daily_ai_costs || [];
  const costData = dailyCosts.map((d) => d.cost || 0);
  const costLabels = dailyCosts.map((d) => fmtDate(d.day));
  const hhFeatures = ft.household_features || [];
  const referrals = ft.referrals || {};

  // Churned families + web traffic (new)
  const churned = ov.churned_families || [];
  const webTraffic = ov.web_traffic || {};
  const webSessionsData = (webTraffic.sessions_by_day || []).map((d) => d.sessions || 0);
  const webUsersData = (webTraffic.sessions_by_day || []).map((d) => d.users || 0);
  const webTrafficLabels = (webTraffic.sessions_by_day || []).map((d) => fmtDate(d.day));

  // Bot heartbeat
  const botAge = ov.bot_last_message_at ? Date.now() - new Date(ov.bot_last_message_at).getTime() : Infinity;
  const botColor = botAge < 600000 ? "#2AB673" : botAge < 3600000 ? "#F5A623" : "#E8725C";
  const botLabel = botAge < 600000 ? "Healthy" : botAge < 3600000 ? "Slow" : "Down";

  // Funnel max for bar widths
  const funnelMax = Math.max(...FUNNEL_STEPS.map((s) => funnelCounts[s]?.count || 0), 1);

  return (
    <div style={{
      fontFamily: "'Nunito', sans-serif", background: "var(--cream)", minHeight: "100dvh",
      overflowY: "auto", color: "var(--dark)",
    }}>
      <style>{`
        @keyframes admSpin { to { transform: rotate(360deg); } }
        @keyframes admPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .adm-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        .adm-grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
        @media (max-width: 700px) {
          .adm-grid3 { grid-template-columns: 1fr; }
          .adm-grid4 { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>

        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 28, flexWrap: "wrap", gap: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={onBack} style={{
              background: "none", border: "none", cursor: "pointer", fontSize: 22,
              color: "var(--muted)", padding: "4px 8px", borderRadius: 8, lineHeight: 1,
            }} title="Back to app">&larr;</button>
            <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: "var(--dark)" }}>Sheli Admin</h1>
            {refreshing && (
              <div style={{
                width: 16, height: 16, border: "2px solid var(--border)", borderTopColor: "var(--accent)",
                borderRadius: "50%", animation: "admSpin 0.8s linear infinite",
              }} />
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {[{v:1,l:"24h"},{v:7,l:"7d"},{v:14,l:"14d"},{v:30,l:"30d"}].map(({v,l}) => (
              <button key={v} onClick={() => setPeriod(v)} style={{
                padding: "6px 14px", borderRadius: 100, fontSize: 13, fontWeight: 600,
                cursor: "pointer", border: "1.5px solid",
                borderColor: period === v ? "var(--accent)" : "var(--border)",
                background: period === v ? "var(--accent)" : "transparent",
                color: period === v ? "#fff" : "var(--warm)",
                fontFamily: "'Nunito', sans-serif",
                transition: "all 0.15s",
              }}>
                {l}
              </button>
            ))}
            <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>
              {lastRefresh ? `Updated ${fmtTime(lastRefresh)}` : ""} &middot; Auto-refresh: 60s
            </span>
          </div>
        </div>

        {/* ── Error banner (non-blocking) ── */}
        {error && overview && (
          <div style={{
            background: "var(--primary-light)", border: "1px solid var(--primary)",
            borderRadius: 8, padding: "10px 16px", marginBottom: 20,
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <span style={{ fontSize: 13, color: "var(--primary)" }}>{error}</span>
            <button onClick={() => fetchAll()} style={{
              background: "var(--primary)", color: "#fff", border: "none", borderRadius: 6,
              padding: "4px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              fontFamily: "'Nunito', sans-serif",
            }}>Retry</button>
          </div>
        )}

        {/* ══════════════════════════════════════════════
            Section 0: Family Health
        ══════════════════════════════════════════════ */}
        <Section title="Family Health" subtitle="Big picture">
          <div className="adm-grid3" style={{ marginBottom: 20 }}>
            <StatCard label="Total Families" value={ov.total_households || 0} sub="registered" color="var(--warm)" />
            <StatCard
              label="Active Families"
              value={ov.active_households || 0}
              sub={`${pct(ov.active_households, ov.total_households)} of total`}
              color="var(--accent)"
            />
            <StatCard
              label="Paying Families"
              value={ov.paying_households || 0}
              sub={ov.paying_households ? `${pct(ov.paying_households, ov.total_households)} of total` : "none yet"}
              color={ov.paying_households ? "var(--primary)" : "var(--muted)"}
            />
          </div>

          {weekData.length > 0 && (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
            }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>{isHourlyTrend ? "Hourly Active Trend (24h)" : "Weekly Active Trend"}</h3>
              <Sparkline data={weekData} height={120} color="var(--accent)" fillOpacity={0.12} labels={weekLabels} />
            </div>
          )}
        </Section>

        {/* ══════════════════════════════════════════════
            Section 1: Activity Pulse
        ══════════════════════════════════════════════ */}
        <Section title="Activity Pulse" subtitle="Is it working?">
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
            {/* Bot heartbeat */}
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, minWidth: 180,
            }}>
              <div style={{
                width: 14, height: 14, borderRadius: "50%", background: botColor,
                animation: botAge < 600000 ? "admPulse 2s ease-in-out infinite" : "none",
                boxShadow: `0 0 8px ${botColor}40`,
              }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--dark)" }}>Bot: {botLabel}</div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Last msg: {relativeTime(ov.bot_last_message_at)}
                </div>
              </div>
            </div>
          </div>

          {waData.length > 0 && (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: 20, marginBottom: 20,
            }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 4px" }}>{isHourly ? "Messages (24h by hour)" : "Messages (14 days)"}</h3>
              <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
                <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--accent)", marginRight: 4, verticalAlign: "middle" }} />WhatsApp</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--primary)", marginRight: 4, verticalAlign: "middle" }} />Web</span>
              </div>
              <Sparkline
                data={waData}
                secondData={webData}
                secondColor="var(--primary)"
                height={140}
                color="var(--accent)"
                fillOpacity={0.1}
                labels={msgLabels}
              />
            </div>
          )}

          <div style={{
            background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
          }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>Per-Household Activity</h3>
            <DataTable
              columns={[
                { key: "name", label: "Name", render: (r) => <span style={{ fontWeight: 600 }}>{r.name || "Unnamed"}</span> },
                { key: "wa_msgs", label: "WA Msgs" },
                { key: "web_msgs", label: "Web Msgs" },
                { key: "total", label: "Total", render: (r) => <span style={{ fontWeight: 700, color: "var(--accent)" }}>{(r.wa_msgs || 0) + (r.web_msgs || 0)}</span> },
                { key: "last_active", label: "Last Active", render: (r) => relativeTime(r.last_active) },
                { key: "member_count", label: "Members" },
              ]}
              rows={households}
              emptyMsg="No household data"
            />
          </div>
        </Section>

        {/* ══════════════════════════════════════════════
            Section 2: Onboarding Funnel
        ══════════════════════════════════════════════ */}
        <Section title="Onboarding Funnel" subtitle="Is the funnel converting?">
          <div style={{
            background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
            padding: 20, marginBottom: 20,
          }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {FUNNEL_STEPS.map((step, i) => {
                const count = funnelCounts[step]?.count || 0;
                if (count === 0) return null;
                const barWidth = funnelMax ? (count / funnelMax) * 100 : 0;
                const pctOfTotal = fn.total_conversations > 0 ? Math.round((count / fn.total_conversations) * 100) : 0;

                return (
                  <div key={step}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--dark)" }}>{FUNNEL_LABELS[step] || step}</span>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        {count} ({pctOfTotal}%)
                      </span>
                    </div>
                    <div style={{
                      height: 28, borderRadius: 6, background: "var(--border)", overflow: "hidden",
                    }}>
                      <div style={{
                        height: "100%", width: `${Math.max(barWidth, 2)}%`,
                        background: FUNNEL_COLORS[i], borderRadius: 6,
                        display: "flex", alignItems: "center", paddingLeft: 8,
                        transition: "width 0.5s ease",
                      }}>
                        {barWidth > 15 && (
                          <span style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>{count}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{
              display: "flex", gap: 24, marginTop: 20, paddingTop: 16,
              borderTop: "1px solid var(--border)", flexWrap: "wrap",
            }}>
              <div>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>Avg msgs to convert</span>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--dark)" }}>
                  {fn.avg_msgs_to_convert != null ? fn.avg_msgs_to_convert.toFixed(1) : "N/A"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>Avg hours to convert</span>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--dark)" }}>
                  {fn.avg_hours_to_convert != null ? fn.avg_hours_to_convert.toFixed(1) : "N/A"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>Total 1:1 conversations</span>
                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--dark)" }}>{fn.total_conversations || 0}</div>
              </div>
            </div>
          </div>

          <div style={{
            background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
          }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>Recent Conversations</h3>
            <DataTable
              columns={[
                { key: "phone", label: "Phone", render: (r) => <span style={{ fontFamily: "monospace", fontSize: 12 }}>{r.phone || "N/A"}</span> },
                { key: "state", label: "State", render: (r) => {
                  const stateStyles = {
                    welcomed: { bg: "var(--accent-soft)", color: "var(--accent)" },
                    chatting: { bg: "#E8F5E9", color: "#2AB673" },
                    invited: { bg: "#EBF5FF", color: "#5B8DEF" },
                    joined: { bg: "#E0F2F1", color: "#1E9E5E" },
                    personal: { bg: "#E8F5E9", color: "#17804B" },
                    nudging: { bg: "#FFF3E0", color: "#F5A623" },
                    sleeping: { bg: "#FBE9E7", color: "#E8725C" },
                    dormant: { bg: "var(--border)", color: "var(--muted)" },
                  };
                  const s = stateStyles[r.state] || { bg: "var(--border)", color: "var(--warm)" };
                  return (
                    <span style={{
                      display: "inline-block", padding: "2px 8px", borderRadius: 100, fontSize: 11,
                      fontWeight: 600, textTransform: "capitalize", background: s.bg, color: s.color,
                    }}>{FUNNEL_LABELS[r.state] || r.state}</span>
                  );
                }},
                { key: "messages", label: "Msgs" },
                { key: "referral", label: "Referral", render: (r) => r.referral || "-" },
                { key: "started", label: "Started", render: (r) => relativeTime(r.started) },
              ]}
              rows={conversations}
              emptyMsg="No conversations yet"
            />
          </div>
        </Section>

        {/* ══════════════════════════════════════════════
            Section 3: Feature Adoption
        ══════════════════════════════════════════════ */}
        <Section title="Feature Adoption" subtitle="What features do families use?">
          <div style={{
            background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
            padding: 20, marginBottom: 20,
          }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
              <DonutChart data={intents} />
              {intents.ignore != null && (
                <div style={{
                  background: "var(--cream)", borderRadius: 12, padding: "12px 16px",
                  display: "flex", flexDirection: "column", gap: 2, alignSelf: "center",
                }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>Noise filtered (ignore)</span>
                  <span style={{ fontSize: 24, fontWeight: 800, color: "var(--warm)" }}>{intents.ignore}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>
                    {pct(intents.ignore, Object.values(intents).reduce((s, v) => s + v, 0))} of all messages
                  </span>
                </div>
              )}
            </div>
          </div>

          <div style={{
            background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
          }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>Per-Household Features</h3>
            <DataTable
              columns={[
                { key: "name", label: "Name", render: (r) => <span style={{ fontWeight: 600 }}>{r.name || "Unnamed"}</span> },
                { key: "tasks", label: "Tasks" },
                { key: "shopping", label: "Shopping" },
                { key: "events", label: "Events" },
                { key: "reminders", label: "Reminders" },
                { key: "rotations", label: "Rotations" },
                { key: "corrections", label: "Corrections" },
              ]}
              rows={hhFeatures}
              emptyMsg="No feature data"
            />
          </div>
        </Section>

        {/* ══════════════════════════════════════════════
            Section 4: AI Cost Control
        ══════════════════════════════════════════════ */}
        <Section title="AI Cost Control" subtitle="Spending">
          <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap", alignItems: "stretch" }}>
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: 20, minWidth: 160,
            }}>
              <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Estimated Cost</span>
              <div style={{
                fontSize: 42, fontWeight: 800, lineHeight: 1.1, marginTop: 4,
                color: (aiCosts.estimated_cost_usd || 0) < 0.5 ? "var(--accent)" : "var(--primary)",
              }}>
                ${(aiCosts.estimated_cost_usd || 0).toFixed(2)}
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>last {period} days</span>
            </div>

            <div className="adm-grid4" style={{ flex: 1, minWidth: 280 }}>
              <StatCard small label="Haiku Calls" value={aiCosts.haiku_calls || 0} color="var(--accent)" />
              <StatCard small label="Sonnet Calls" value={aiCosts.sonnet_calls || 0} color="var(--primary)" />
              <StatCard
                small
                label="Escalation Rate"
                value={aiCosts.total_classified ? `${Math.round((aiCosts.sonnet_calls || 0) / aiCosts.total_classified * 100)}%` : "0%"}
                color="#5B8DEF"
              />
              <StatCard
                small
                label="Ignore Rate"
                value={aiCosts.ignore_rate_pct != null ? `${aiCosts.ignore_rate_pct.toFixed(0)}%` : "0%"}
                color="var(--warm)"
              />
            </div>
          </div>

          {costData.length > 0 && (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
            }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>Daily AI Cost</h3>
              <Sparkline data={costData} height={120} color="var(--primary)" fillOpacity={0.08} labels={costLabels} />
            </div>
          )}
        </Section>

        {/* ══════════════════════════════════════════════
            Section 5: App Traffic
        ══════════════════════════════════════════════ */}
        <Section title="App Traffic" subtitle="Web app opens & unique users">
          <div className="adm-grid3">
            <StatCard label="App Opens" value={webTraffic.total_sessions || 0} color="var(--accent)" subtitle={`Last ${period}d`} />
            <StatCard label="Unique Users" value={webTraffic.unique_users || 0} color="var(--primary)" subtitle={`Last ${period}d`} />
            <StatCard
              label="Opens/User"
              value={webTraffic.unique_users ? (webTraffic.total_sessions / webTraffic.unique_users).toFixed(1) : "0"}
              color="#5B8DEF"
              subtitle="Avg frequency"
            />
          </div>
          {webSessionsData.length > 0 && webSessionsData.some((v) => v > 0) && (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: 20, marginTop: 16,
            }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 4px" }}>Sessions (14 days)</h3>
              <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
                <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--accent)", marginRight: 4, verticalAlign: "middle" }} />Opens</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#5B8DEF", marginRight: 4, verticalAlign: "middle" }} />Unique Users</span>
              </div>
              <Sparkline
                data={webSessionsData}
                secondData={webUsersData}
                secondColor="#5B8DEF"
                height={120}
                color="var(--accent)"
                fillOpacity={0.1}
                labels={webTrafficLabels}
              />
            </div>
          )}
          {(!webSessionsData.length || webSessionsData.every((v) => v === 0)) && (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: "40px 20px", textAlign: "center", marginTop: 16,
            }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>&#128202;</div>
              <p style={{ fontSize: 14, color: "var(--muted)" }}>No web traffic yet</p>
              <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Sessions will appear after users open the app</p>
            </div>
          )}
        </Section>

        {/* ══════════════════════════════════════════════
            Section 5b: Channels — 1:1 / group / both breakdown
        ══════════════════════════════════════════════ */}
        <Section title="Channels" subtitle="How the user base splits between personal and group usage">
          {channelStats && Object.keys(channelStats).length > 0 ? (
            <>
              {/* NOTE: channelStats.funnel_counts is unused — duplicates admin_funnel_stats. Remove from RPC later. */}
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
              }}>
                <DonutChart
                  data={Object.keys(CHANNEL_LABELS).map((key) => ({
                    label: CHANNEL_LABELS[key],
                    value: channelStats.channels[key].households,
                    color: CHANNEL_COLORS[key],
                  }))}
                  size={160}
                  centerLabel="homes"
                />
              </div>

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

        {/* ══════════════════════════════════════════════
            Section 6: Past Families (Churned)
        ══════════════════════════════════════════════ */}
        <Section title="Past Families" subtitle="Removed Sheli from group">
          {churned.length > 0 ? (
            <>
              <div className="adm-grid3">
                <StatCard label="Lost Families" value={churned.length} color="#E8725C" />
              </div>
              <div style={{
                background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
                padding: 20, marginTop: 16,
              }}>
                <DataTable
                  columns={[
                    { key: "name", label: "Family", render: (r) => <span style={{ fontWeight: 600, color: "#E8725C" }}>{r.name || "Unnamed"}</span> },
                    { key: "total_messages", label: "Messages" },
                    { key: "last_message_at", label: "Last Active", render: (r) => relativeTime(r.last_message_at) },
                    { key: "days_gone", label: "Days Gone", render: (r) => <span style={{ fontWeight: 600, color: "var(--muted)" }}>{r.days_gone || 0}d</span> },
                  ]}
                  rows={churned}
                  emptyMsg="No churned families"
                />
              </div>
            </>
          ) : (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: "40px 20px", textAlign: "center",
            }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>&#127881;</div>
              <p style={{ fontSize: 14, color: "var(--accent)", fontWeight: 600 }}>No families lost!</p>
            </div>
          )}
        </Section>

        {/* ══════════════════════════════════════════════
            Section 7: Waitlist (recovery-period acquisition)
        ══════════════════════════════════════════════ */}
        <Section title="Waitlist" subtitle="Landing-page signups while outbound is paused">
          {waitlistStats && waitlistStats.totals ? (() => {
            const wl = waitlistStats;
            const t = wl.totals || {};
            const daily = wl.signups_by_day || [];
            const dailyData = daily.map((d) => d.count || 0);
            const dailyLabels = daily.map((d) => fmtDate(d.day));
            const bySource = wl.by_source || {};
            const byInterest = wl.by_interest || {};
            const recent = wl.recent || [];
            const consentPct = t.total_signups ? Math.round((t.with_consent / t.total_signups) * 100) : 0;
            const activationPct = t.invited ? Math.round((t.activated / t.invited) * 100) : 0;
            return (
              <>
                <div className="adm-grid4" style={{ marginBottom: 16 }}>
                  <StatCard
                    label="Total Signups"
                    value={t.total_signups || 0}
                    sub={t.first_signup ? `since ${fmtDate(t.first_signup)}` : "none yet"}
                    color="var(--accent)"
                  />
                  <StatCard
                    label={`Signups (${period}d)`}
                    value={t.signups_in_period || 0}
                    sub={t.latest_signup ? `last ${relativeTime(t.latest_signup)}` : "—"}
                    color="var(--primary)"
                  />
                  <StatCard
                    label="With Consent"
                    value={t.with_consent || 0}
                    sub={`${consentPct}% of total`}
                    color="#5B8DEF"
                  />
                  <StatCard
                    label="Invited → Activated"
                    value={`${t.activated || 0} / ${t.invited || 0}`}
                    sub={t.invited ? `${activationPct}% activation` : "not invited yet"}
                    color="var(--warm)"
                  />
                </div>

                {dailyData.some((v) => v > 0) && (
                  <div style={{
                    background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
                    padding: 20, marginBottom: 16,
                  }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>
                      Signups by day ({period}d)
                    </h3>
                    <Sparkline data={dailyData} height={120} color="var(--accent)" fillOpacity={0.12} labels={dailyLabels} />
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }} className="adm-grid-2">
                  <div style={{
                    background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
                  }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>By source</h3>
                    <DataTable
                      columns={[
                        { key: "source", label: "Source", render: (r) => <span style={{ fontWeight: 600 }}>{r.source}</span> },
                        { key: "count", label: "Signups" },
                        { key: "pct", label: "%", render: (r) => pct(r.count, t.total_signups) },
                      ]}
                      rows={Object.entries(bySource)
                        .map(([source, count]) => ({ source, count }))
                        .sort((a, b) => b.count - a.count)}
                      emptyMsg="No source data"
                    />
                  </div>
                  <div style={{
                    background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
                  }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>By interest</h3>
                    <DataTable
                      columns={[
                        { key: "interest", label: "Interest", render: (r) => <span style={{ fontWeight: 600 }}>{r.interest}</span> },
                        { key: "count", label: "Signups" },
                        { key: "pct", label: "%", render: (r) => pct(r.count, t.total_signups) },
                      ]}
                      rows={Object.entries(byInterest)
                        .map(([interest, count]) => ({ interest, count }))
                        .sort((a, b) => b.count - a.count)}
                      emptyMsg="No interest data"
                    />
                  </div>
                </div>

                <div style={{
                  background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)", padding: 20,
                }}>
                  <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)", margin: "0 0 12px" }}>Recent signups</h3>
                  <DataTable
                    columns={[
                      { key: "created_at", label: "When", render: (r) => relativeTime(r.created_at) },
                      { key: "name", label: "Name", render: (r) => [r.first_name, r.last_name].filter(Boolean).join(" ") || "—" },
                      { key: "phone", label: "Phone" },
                      { key: "email", label: "Email", render: (r) => r.email || "—" },
                      { key: "interest", label: "Interest", render: (r) => r.interest || "—" },
                      { key: "source", label: "Source", render: (r) => r.source || "—" },
                      { key: "consent_given", label: "Consent", render: (r) => r.consent_given ? "✓" : "—" },
                    ]}
                    rows={recent}
                    emptyMsg="No signups yet"
                  />
                </div>
              </>
            );
          })() : waitlistError ? (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: "24px 20px",
            }}>
              <p style={{ fontSize: 13, color: "var(--muted)", margin: 0 }}>
                Waitlist analytics unavailable: <code style={{ fontSize: 12 }}>{waitlistError}</code>
              </p>
              <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0" }}>
                Apply migration <code>2026_04_20_admin_waitlist_stats.sql</code> to enable.
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "var(--muted)" }}>Loading waitlist…</p>
          )}
        </Section>

        {/* ══════════════════════════════════════════════
            Section 8: Referrals
        ══════════════════════════════════════════════ */}
        <Section title="Referrals" subtitle="Growth">
          {(referrals.codes_generated || referrals.completed || referrals.total) ? (
            <div className="adm-grid3">
              <StatCard label="Codes Generated" value={referrals.codes_generated || 0} color="var(--accent)" />
              <StatCard label="Completed" value={referrals.completed || 0} color="var(--primary)" />
              <StatCard
                label="Conversion Rate"
                value={referrals.conversion_pct != null ? `${referrals.conversion_pct.toFixed(0)}%` : "0%"}
                color="#5B8DEF"
              />
            </div>
          ) : (
            <div style={{
              background: "var(--white)", borderRadius: "var(--radius-card)", boxShadow: "var(--sh)",
              padding: "40px 20px", textAlign: "center",
            }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>&#127793;</div>
              <p style={{ fontSize: 14, color: "var(--muted)" }}>No referral activity yet</p>
              <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                Referral codes will appear here once families start sharing
              </p>
            </div>
          )}
        </Section>

        {/* ── Footer ── */}
        <div style={{ textAlign: "center", padding: "20px 0 40px", fontSize: 12, color: "var(--muted)" }}>
          Sheli Admin Dashboard &middot; Period: {period} days &middot; {ov.total_households || 0} families
        </div>
      </div>
    </div>
  );
}

const btnStyle = {
  padding: "10px 24px",
  borderRadius: 12,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'Nunito', sans-serif",
};
