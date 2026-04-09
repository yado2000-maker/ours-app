import { useState } from "react";
import T from "../locales/index.js";
import { supabase } from "../lib/supabase.js";

/**
 * JoinOrCreate — Household onboarding choice screen.
 *
 * Shown to authenticated users who don't have a household yet.
 * Three paths:
 *   A) Auto-detected household (prominent card at top if found)
 *   B) Join by invite code (text input)
 *   C) Create new household (goes to Setup)
 *
 * Props:
 *   lang               "he" | "en"
 *   onJoinHousehold     (householdId: string) => Promise<void>
 *   onCreateNew         () => void
 *   detectedHousehold   null | { id, name, lang, members: [{name}] }
 */
export default function JoinOrCreate({
  lang = "he",
  onJoinHousehold,
  onCreateNew,
  detectedHousehold,
}) {
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneLinking, setPhoneLinking] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [joiningDetected, setJoiningDetected] = useState(false);

  const isHe = lang === "he";
  const dir = isHe ? "rtl" : "ltr";
  const font = isHe ? "'Heebo',sans-serif" : "'Nunito',sans-serif";

  const handleJoinDetected = async () => {
    if (!detectedHousehold) return;
    setJoiningDetected(true);
    setError(null);
    try {
      await onJoinHousehold(detectedHousehold.id);
    } catch (e) {
      setError(
        isHe
          ? "לא הצלחנו להצטרף — נסו שוב"
          : "Could not join — please try again"
      );
      setJoiningDetected(false);
    }
  };

  const handleJoinByCode = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      await onJoinHousehold(trimmed);
    } catch (e) {
      setError(
        isHe
          ? "לא נמצא משק בית עם הקוד הזה"
          : "No household found with this code"
      );
    }
    setLoading(false);
  };

  const handlePhoneLookup = async () => {
    const trimmed = phone.trim().replace(/[\s\-()]/g, "");
    if (!trimmed || trimmed.length < 9) return;
    setPhoneLinking(true);
    setError(null);
    try {
      const { data: hhId, error: rpcErr } = await supabase.rpc("link_user_to_household", { p_phone: trimmed, p_email: "" });
      if (rpcErr) throw rpcErr;
      if (hhId) {
        await onJoinHousehold(hhId);
      } else {
        setError(isHe ? "לא מצאנו משפחה עם המספר הזה. נסו מספר אחר או צרו בית חדש" : "No family found with this number. Try another or create a new home");
      }
    } catch (e) {
      setError(isHe ? "שגיאה — נסו שוב" : "Error — try again");
    }
    setPhoneLinking(false);
  };

  // ── Shared inline style helpers ──

  const s = {
    // Full-screen wrapper
    wrap: {
      minHeight: "100dvh",
      background: "var(--cream)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "48px 24px 36px",
      fontFamily: font,
      overflowY: "auto",
      animation: "fadeIn 0.35s ease",
    },

    // Sheli wordmark
    wordmark: {
      fontFamily: "'Nunito', sans-serif",
      fontWeight: 800,
      fontSize: 38,
      letterSpacing: "0.04em",
      background: "linear-gradient(135deg, #E8725C, #D4507A)",
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      marginBottom: 6,
      userSelect: "none",
    },

    // Subtitle
    subtitle: {
      fontSize: 14,
      color: "var(--muted)",
      fontWeight: 300,
      letterSpacing: "0.02em",
      textAlign: "center",
      lineHeight: 1.55,
      maxWidth: 300,
      marginBottom: 32,
    },

    // Content container
    content: {
      width: "100%",
      maxWidth: 360,
      display: "flex",
      flexDirection: "column",
      gap: 0,
    },

    // Detected household card
    detectedCard: {
      background: "var(--white)",
      borderRadius: 18,
      padding: "22px 20px 18px",
      border: "2px solid var(--accent)",
      boxShadow:
        "0 2px 18px rgba(232, 114, 92, 0.12), 0 1px 4px rgba(0,0,0,0.04)",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      marginBottom: 28,
      animation: "slideUp 0.35s ease 0.1s both",
      position: "relative",
      overflow: "hidden",
    },

    detectedCardGlow: {
      position: "absolute",
      top: -40,
      right: -40,
      width: 120,
      height: 120,
      borderRadius: "50%",
      background: "rgba(232, 114, 92, 0.06)",
      pointerEvents: "none",
    },

    detectedLabel: {
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: isHe ? 0 : "0.08em",
      textTransform: isHe ? "none" : "uppercase",
      color: "var(--accent)",
    },

    detectedName: {
      fontFamily: "'Nunito', sans-serif",
      fontSize: 24,
      fontWeight: 700,
      color: "var(--dark)",
      lineHeight: 1.2,
      display: "flex",
      alignItems: "center",
      gap: 8,
    },

    detectedMembers: {
      fontSize: 13,
      color: "var(--muted)",
      fontWeight: 300,
      lineHeight: 1.5,
    },

    joinDetectedBtn: {
      padding: "14px 20px",
      borderRadius: 14,
      background: "var(--dark)",
      color: "var(--white)",
      border: "none",
      cursor: joiningDetected ? "not-allowed" : "pointer",
      fontSize: 15,
      fontWeight: 500,
      fontFamily: "inherit",
      transition: "background 0.2s, transform 0.1s",
      opacity: joiningDetected ? 0.55 : 1,
      marginTop: 4,
    },

    // Divider with text
    divider: {
      display: "flex",
      alignItems: "center",
      gap: 14,
      margin: "0 0 24px",
    },

    dividerLine: {
      flex: 1,
      height: 1,
      background: "var(--border)",
    },

    dividerText: {
      fontSize: 12,
      color: "var(--muted)",
      fontWeight: 400,
      flexShrink: 0,
    },

    // Section label
    sectionLabel: {
      fontSize: 13,
      fontWeight: 500,
      color: "var(--warm)",
      marginBottom: 10,
      textAlign: isHe ? "right" : "left",
    },

    // Code input row
    codeRow: {
      display: "flex",
      gap: 8,
      marginBottom: 28,
    },

    codeInput: {
      flex: 1,
      padding: "13px 15px",
      borderRadius: 12,
      border: "1.5px solid var(--border)",
      background: "var(--white)",
      fontSize: 15,
      color: "var(--dark)",
      outline: "none",
      fontFamily: "'Nunito', sans-serif",
      textAlign: "start",
      transition: "border-color 0.2s",
      direction: "ltr",
    },

    codeBtn: {
      padding: "13px 22px",
      borderRadius: 12,
      background: "var(--dark)",
      color: "var(--white)",
      border: "none",
      cursor: loading ? "not-allowed" : "pointer",
      fontSize: 14,
      fontWeight: 500,
      fontFamily: "inherit",
      transition: "background 0.18s",
      whiteSpace: "nowrap",
      opacity: loading ? 0.55 : 1,
    },

    // Create new button (secondary)
    createBtn: {
      padding: "15px 20px",
      borderRadius: 14,
      background: "transparent",
      border: "1.5px solid var(--border)",
      color: "var(--warm)",
      cursor: "pointer",
      fontSize: 15,
      fontWeight: 500,
      fontFamily: "inherit",
      transition: "all 0.18s",
      textAlign: "center",
    },

    // Error message
    error: {
      fontSize: 13,
      color: "var(--primary)",
      textAlign: "center",
      marginBottom: 12,
      animation: "fadeIn 0.2s ease",
    },
  };

  return (
    <div style={s.wrap} dir={dir}>
      {/* Wordmark */}
      <div style={s.wordmark}>sheli</div>

      {/* Subtitle */}
      <p style={s.subtitle}>
        {isHe
          ? "בואו נתחיל"
          : "Let's get started"}
      </p>

      <div style={s.content}>
        {/* ── Path A: Auto-detected household ── */}
        {detectedHousehold && (
          <div style={s.detectedCard}>
            <div style={s.detectedCardGlow} />
            <span style={s.detectedLabel}>
              {isHe ? "מצאנו את הבית שלכם" : "We found your home"}
            </span>
            <div style={s.detectedName}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>&#x1F3E0;</span>
              {detectedHousehold.name || (isHe ? "הבית שלנו" : "Our Home")}
            </div>
            {detectedHousehold.members?.length > 0 && (
              <p style={s.detectedMembers}>
                {detectedHousehold.members.map((m) => m.name).join(", ")}
              </p>
            )}
            <button
              style={s.joinDetectedBtn}
              onClick={handleJoinDetected}
              disabled={joiningDetected}
              onMouseEnter={(e) => {
                if (!joiningDetected)
                  e.currentTarget.style.background = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                if (!joiningDetected)
                  e.currentTarget.style.background = "var(--dark)";
              }}
            >
              {joiningDetected
                ? isHe
                  ? "מצטרפים..."
                  : "Joining..."
                : isHe
                ? "הצטרפו \u2190"
                : "Join \u2192"}
            </button>
          </div>
        )}

        {/* ── Error ── */}
        {error && <p style={s.error}>{error}</p>}

        {/* ── Divider (after detected card, or at top if no detected) ── */}
        {detectedHousehold && (
          <div style={s.divider}>
            <div style={s.dividerLine} />
            <span style={s.dividerText}>{isHe ? "או" : "or"}</span>
            <div style={s.dividerLine} />
          </div>
        )}

        {/* ── Path C: Create new (PRIMARY CTA) ── */}
        <button
          style={{...s.createBtn, background: "var(--dark)", color: "var(--white)", border: "1.5px solid var(--dark)", fontWeight: 500}}
          onClick={onCreateNew}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--dark)"; e.currentTarget.style.borderColor = "var(--dark)"; }}
        >
          {isHe ? "צרו בית חדש ב-Sheli" : "Set up a new home"}
        </button>

        {/* ── Divider ── */}
        <div style={s.divider}>
          <div style={s.dividerLine} />
          <span style={s.dividerText}>{isHe ? "או" : "or"}</span>
          <div style={s.dividerLine} />
        </div>

        {/* ── Path B2: Find by WhatsApp phone ── */}
        <p style={s.sectionLabel}>
          {isHe ? "כבר משתמשים בשלי בווטסאפ? הכניסו את מספר הטלפון" : "Already using Sheli on WhatsApp? Enter your phone"}
        </p>
        <div style={s.codeRow}>
          <input
            type="tel"
            value={phone}
            onChange={(e) => { setPhone(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => e.key === "Enter" && handlePhoneLookup()}
            placeholder={isHe ? "למשל 0521234567" : "e.g. 0521234567"}
            style={s.codeInput}
            dir="ltr"
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
          />
          <button
            style={s.codeBtn}
            onClick={handlePhoneLookup}
            disabled={phoneLinking || !phone.trim()}
            onMouseEnter={(e) => { if (!phoneLinking) e.currentTarget.style.background = "var(--accent)"; }}
            onMouseLeave={(e) => { if (!phoneLinking) e.currentTarget.style.background = "var(--dark)"; }}
          >
            {phoneLinking ? "..." : isHe ? "חפשו" : "Find"}
          </button>
        </div>

        {/* ── Divider ── */}
        <div style={s.divider}>
          <div style={s.dividerLine} />
          <span style={s.dividerText}>{isHe ? "או" : "or"}</span>
          <div style={s.dividerLine} />
        </div>

        {/* ── Path B: Join by code (SECONDARY) ── */}
        <p style={s.sectionLabel}>
          {isHe ? "הצטרפו עם הקוד של הבית" : "Join with a home code"}
        </p>
        <div style={s.codeRow}>
          <input
            type="text"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && handleJoinByCode()}
            placeholder={
              isHe
                ? "הדביקו קוד שקיבלתם..."
                : "Paste the code you received..."
            }
            style={s.codeInput}
            dir="ltr"
            onFocus={(e) =>
              (e.currentTarget.style.borderColor = "var(--accent)")
            }
            onBlur={(e) =>
              (e.currentTarget.style.borderColor = "var(--border)")
            }
          />
          <button
            style={s.codeBtn}
            onClick={handleJoinByCode}
            disabled={loading || !code.trim()}
            onMouseEnter={(e) => {
              if (!loading) e.currentTarget.style.background = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              if (!loading) e.currentTarget.style.background = "var(--dark)";
            }}
          >
            {loading
              ? "..."
              : isHe
              ? "הצטרפו"
              : "Join"}
          </button>
        </div>

        {/* ── Hint text ── */}
        <p
          style={{
            fontSize: 12,
            color: "var(--muted)",
            fontWeight: 300,
            textAlign: "center",
            marginTop: 16,
            lineHeight: 1.6,
            maxWidth: 280,
            alignSelf: "center",
          }}
        >
          {isHe
            ? "מי שהגדיר/ה את הבית יכול/ה לשתף את הקוד מההגדרות"
            : "Whoever set up the home can share the code from Settings"}
        </p>
      </div>

      {/* L14: keyframes already defined in app.css — removed inline duplicate */}
    </div>
  );
}
