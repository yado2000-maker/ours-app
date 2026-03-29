import { useState } from "react";
import T from "../locales/index.js";

// Welcome screen — shows value before asking for auth
// Flow: Language pick → Value prop → CTA → Auth
export default function WelcomeScreen({ onGetStarted, onSignIn }) {
  const [lang, setLang] = useState(null);
  const [step, setStep] = useState(0); // 0=lang, 1=value

  const t = lang ? T[lang] : T.en;
  const dir = lang === "he" ? "rtl" : "ltr";
  const isHe = lang === "he";
  const font = isHe ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";

  // Mock WhatsApp conversation to show the bot in action
  const mockChat = isHe ? [
    { sender: "אמא", text: "מישהו יכול לאסוף את נועה מבלט ב-5?", side: "left" },
    { sender: "Ours 🏠", text: "📅 הוספתי: לאסוף את נועה מבלט ב-17:00\nמי לוקח?", side: "bot" },
    { sender: "אבא", text: "אני. תזכירו לי לקנות חלב", side: "right" },
    { sender: "Ours 🏠", text: "✅ האיסוף → אבא\n🛒 חלב נוסף לרשימה\n⏰ תזכורת ב-16:45", side: "bot" },
  ] : [
    { sender: "Mom", text: "Can someone pick up Noa from ballet at 5?", side: "left" },
    { sender: "Ours 🏠", text: "📅 Added: Pick up Noa from ballet at 5pm\nWho's taking this?", side: "bot" },
    { sender: "Dad", text: "Me. Remind me to buy milk on the way", side: "right" },
    { sender: "Ours 🏠", text: "✅ Pickup → Dad\n🛒 Milk added to list\n⏰ Reminder at 4:45pm", side: "bot" },
  ];

  const features = isHe ? [
    { icon: "🛒", title: "רשימת קניות חכמה", sub: "תגידו 'חלב' בקבוצה — ו-Ours מוסיף לרשימה" },
    { icon: "📅", title: "יומן משפחתי", sub: "חוגים, הסעות, אירועים — הכל מסודר אוטומטית" },
    { icon: "✅", title: "מטלות בית", sub: "מי שוטף כלים? מי מוציא אשפה? Ours עוקב" },
  ] : [
    { icon: "🛒", title: "Smart shopping list", sub: "Say 'milk' in the group — Ours adds it to the list" },
    { icon: "📅", title: "Family calendar", sub: "Classes, rides, events — organized automatically" },
    { icon: "✅", title: "Household chores", sub: "Who's doing dishes? Taking out trash? Ours tracks it" },
  ];

  const selectLang = (l) => {
    setLang(l);
    setTimeout(() => setStep(1), 200);
  };

  // Step 0: Language selection
  if (step === 0) {
    return (
      <div style={{
        minHeight: "100dvh",
        background: "var(--cream)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 24px",
        fontFamily: "'DM Sans',sans-serif",
      }}>
        <div style={{
          fontFamily: "'Cormorant Garamond',serif",
          fontWeight: 300,
          fontSize: 42,
          letterSpacing: "0.22em",
          color: "var(--dark)",
          marginBottom: 8,
        }}>Ours</div>
        <p style={{
          fontSize: 14,
          color: "var(--muted)",
          fontWeight: 300,
          marginBottom: 48,
          letterSpacing: "0.03em",
        }}>AI for the life you share together</p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, width: "100%", maxWidth: 300 }}>
          {[
            { code: "en", label: "EN", sub: "English" },
            { code: "he", label: "HE", sub: "עברית" },
          ].map((l) => (
            <div
              key={l.code}
              onClick={() => selectLang(l.code)}
              style={{
                padding: "22px 16px",
                borderRadius: 16,
                border: "2px solid var(--border)",
                background: "var(--white)",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                transition: "all 0.18s",
                boxShadow: "var(--sh)",
              }}
            >
              <span style={{ fontSize: 22, fontWeight: 700, color: "var(--warm)" }}>{l.label}</span>
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--warm)" }}>{l.sub}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Step 1: Value proposition
  return (
    <div
      dir={dir}
      style={{
        minHeight: "100dvh",
        background: "var(--cream)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "32px 20px 24px",
        fontFamily: font,
        maxWidth: 480,
        margin: "0 auto",
        overflow: "auto",
      }}
    >
      {/* Wordmark */}
      <div style={{
        fontFamily: "'Cormorant Garamond',serif",
        fontWeight: 300,
        fontSize: 32,
        letterSpacing: "0.22em",
        color: "var(--dark)",
        marginBottom: 6,
      }}>Ours</div>

      <p style={{
        fontSize: 15,
        color: "var(--dark)",
        fontWeight: 400,
        textAlign: "center",
        lineHeight: 1.6,
        maxWidth: 300,
        marginBottom: 28,
      }}>
        {isHe
          ? "העוזר המשפחתי החכם שגר בקבוצת הוואטסאפ שלכם"
          : "The smart family assistant that lives in your WhatsApp group"}
      </p>

      {/* Mock WhatsApp chat */}
      <div style={{
        width: "100%",
        maxWidth: 340,
        background: "var(--white)",
        borderRadius: 18,
        padding: "16px 14px",
        boxShadow: "var(--shm)",
        border: "1.5px solid var(--border)",
        marginBottom: 28,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}>
        {/* Chat header */}
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: isHe ? 0 : "0.06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          textAlign: "center",
          paddingBottom: 8,
          borderBottom: "1px solid var(--border)",
          marginBottom: 4,
        }}>
          {isHe ? "👨‍👩‍👧 קבוצת המשפחה" : "👨‍👩‍👧 Family Group"}
        </div>

        {mockChat.map((msg, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: msg.side === "bot" ? "center" : (msg.side === "left" ? "flex-start" : "flex-end"),
              animation: `msgIn 0.3s ease ${i * 0.15}s both`,
            }}
          >
            <span style={{
              fontSize: 10,
              color: msg.side === "bot" ? "var(--accent)" : "var(--muted)",
              fontWeight: msg.side === "bot" ? 600 : 400,
              marginBottom: 2,
            }}>
              {msg.sender}
            </span>
            <div style={{
              padding: "8px 12px",
              borderRadius: msg.side === "bot" ? 12 : 14,
              background: msg.side === "bot"
                ? "var(--accent-soft)"
                : msg.side === "left"
                  ? "var(--white)"
                  : "var(--dark)",
              color: msg.side === "bot"
                ? "var(--dark)"
                : msg.side === "left"
                  ? "var(--dark)"
                  : "var(--white)",
              fontSize: 12.5,
              lineHeight: 1.5,
              whiteSpace: "pre-line",
              maxWidth: "85%",
              border: msg.side === "bot" ? "1.5px solid var(--accent)" : (msg.side === "left" ? "1px solid var(--border)" : "none"),
              boxShadow: msg.side === "bot" ? "none" : "var(--sh)",
            }}>
              {msg.text}
            </div>
          </div>
        ))}
      </div>

      {/* Feature pills */}
      <div style={{
        width: "100%",
        maxWidth: 340,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        marginBottom: 32,
      }}>
        {features.map((f, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "12px 16px",
              background: "var(--white)",
              borderRadius: 14,
              border: "1.5px solid var(--border)",
              animation: `msgIn 0.3s ease ${0.6 + i * 0.1}s both`,
            }}
          >
            <span style={{ fontSize: 24, flexShrink: 0 }}>{f.icon}</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--dark)", marginBottom: 2 }}>{f.title}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 300, lineHeight: 1.4 }}>{f.sub}</div>
            </div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <button
        onClick={onGetStarted}
        style={{
          width: "100%",
          maxWidth: 340,
          padding: 16,
          borderRadius: 14,
          background: "var(--dark)",
          color: "var(--white)",
          border: "none",
          cursor: "pointer",
          fontSize: 16,
          fontWeight: 500,
          fontFamily: "inherit",
          transition: "background 0.2s",
          marginBottom: 12,
        }}
      >
        {isHe ? "בואו נתחיל →" : "Get started →"}
      </button>

      {/* Already have account */}
      <button
        onClick={onSignIn}
        style={{
          background: "none",
          border: "none",
          color: "var(--muted)",
          fontSize: 13,
          cursor: "pointer",
          fontFamily: "inherit",
          padding: 8,
        }}
      >
        {isHe ? "יש לי כבר חשבון — התחברות" : "Already have an account — Sign in"}
      </button>
    </div>
  );
}
