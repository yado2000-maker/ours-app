import { useState } from "react";
import T from "../locales/index.js";
import { ShoppingFeatureIcon, CalendarFeatureIcon, ChoresFeatureIcon, BackArrowIcon } from "./Icons.jsx";

// Welcome screen — shows value before asking for auth
// Flow: Language pick → Value prop with WhatsApp-style mock → CTA → Auth
export default function WelcomeScreen({ onGetStarted, onSignIn }) {
  const [lang, setLang] = useState(null);
  const [step, setStep] = useState(0); // 0=lang, 1=value

  const t = lang ? T[lang] : T.en;
  const dir = lang === "he" ? "rtl" : "ltr";
  const isHe = lang === "he";
  const font = isHe ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";

  // Mock WhatsApp conversation — styled like actual WhatsApp
  const mockChat = isHe ? [
    { sender: "אמא", text: "מישהו יכול לאסוף את נועה מבלט ב-5?", side: "other", time: "09:12" },
    { sender: "Ours 🏠", text: "📅 הוספתי: לאסוף את נועה מבלט ב-17:00\nמי לוקח?", side: "bot", time: "09:12" },
    { sender: "אבא", text: "אני. תזכירו לי לקנות חלב", side: "me", time: "09:14" },
    { sender: "Ours 🏠", text: "✅ האיסוף → אבא\n🛒 חלב נוסף לרשימה\n⏰ תזכורת ב-16:45", side: "bot", time: "09:14" },
  ] : [
    { sender: "Mom", text: "Can someone pick up Noa from ballet at 5?", side: "other", time: "9:12 AM" },
    { sender: "Ours 🏠", text: "📅 Added: Pick up Noa from ballet at 5pm\nWho's taking this?", side: "bot", time: "9:12 AM" },
    { sender: "Dad", text: "Me. Remind me to buy milk on the way", side: "me", time: "9:14 AM" },
    { sender: "Ours 🏠", text: "✅ Pickup → Dad\n🛒 Milk added to list\n⏰ Reminder at 4:45pm", side: "bot", time: "9:14 AM" },
  ];

  const features = isHe ? [
    { icon: <ShoppingFeatureIcon size={28} />, title: "רשימת קניות חכמה", sub: "אמרו 'חלב' בקבוצה — Ours מוסיף לרשימה בשנייה" },
    { icon: <CalendarFeatureIcon size={28} />, title: "יומן משפחתי", sub: "חוגים, הסעות, אירועים — מסודרים מעצמם" },
    { icon: <ChoresFeatureIcon size={28} />, title: "חלוקת מטלות", sub: "Ours זוכר מי צריך לעשות מה ומתי" },
  ] : [
    { icon: <ShoppingFeatureIcon size={28} />, title: "Smart shopping list", sub: "Say 'milk' in the group — it's on the list instantly" },
    { icon: <CalendarFeatureIcon size={28} />, title: "Family calendar", sub: "Classes, pickups, events — organized by themselves" },
    { icon: <ChoresFeatureIcon size={28} />, title: "Task sharing", sub: "Ours remembers who needs to do what, and when" },
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

  // WhatsApp colors
  const waBg = "#0b141a";        // WhatsApp dark background
  const waHeader = "#1f2c34";    // WhatsApp header bar
  const waBubbleOther = "#1f2c34"; // Incoming bubble
  const waBubbleMe = "#005c4b";  // Outgoing bubble (green)
  const waBubbleBot = "#103529"; // Bot bubble (slightly different green)
  const waBotBorder = "#25D366"; // WhatsApp green accent for bot
  const waText = "#e9edef";      // WhatsApp text color
  const waTextMuted = "#8696a0"; // WhatsApp muted text
  const waTime = "#8696a0";      // Timestamp color

  // Step 1: Value proposition
  return (
    <div
      dir={dir}
      style={{
        height: "100dvh",
        background: "var(--cream)",
        display: "flex",
        flexDirection: "column",
        fontFamily: font,
        maxWidth: 480,
        margin: "0 auto",
      }}
    >
      {/* Scrollable content area */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "24px 20px 16px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}>
        {/* Wordmark */}
        <div style={{
          fontFamily: "'Cormorant Garamond',serif",
          fontWeight: 300,
          fontSize: 30,
          letterSpacing: "0.22em",
          color: "var(--dark)",
          marginBottom: 4,
        }}>Ours</div>

        <p style={{
          fontSize: 14,
          color: "var(--dark)",
          fontWeight: 400,
          textAlign: "center",
          lineHeight: 1.55,
          maxWidth: 300,
          marginBottom: 20,
        }}>
          {isHe
            ? "העוזר המשפחתי החכם שגר בקבוצת הוואטסאפ שלכם"
            : "The smart family assistant that lives in your WhatsApp group"}
        </p>

        {/* Mock WhatsApp chat — styled like real WhatsApp */}
        <div style={{
          width: "100%",
          maxWidth: 340,
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
          marginBottom: 20,
        }}>
          {/* WhatsApp header bar */}
          <div style={{
            background: waHeader,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%",
              background: "#2a3942",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14,
            }}>👨‍👩‍👧</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: waText }}>
                {isHe ? "קבוצת המשפחה" : "Family Group"}
              </div>
              <div style={{ fontSize: 11, color: waTextMuted }}>
                {isHe ? "אמא, אבא, Ours 🏠, את/ה" : "Mom, Dad, Ours 🏠, You"}
              </div>
            </div>
          </div>

          {/* Chat area with WhatsApp wallpaper */}
          <div style={{
            background: waBg,
            backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
            padding: "12px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            minHeight: 220,
          }}>
            {mockChat.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: msg.side === "me" ? "flex-end" : "flex-start",
                  animation: `msgIn 0.3s ease ${i * 0.15}s both`,
                  marginBottom: 2,
                }}
              >
                {/* Sender name (not for "me" messages) */}
                {msg.side !== "me" && (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: msg.side === "bot" ? "#25D366" : "#53bdeb",
                    marginBottom: 1,
                    padding: "0 6px",
                  }}>
                    {msg.sender}
                  </span>
                )}
                <div style={{
                  padding: "6px 8px 3px",
                  borderRadius: 8,
                  borderTopLeftRadius: msg.side === "me" ? 8 : 0,
                  borderTopRightRadius: msg.side === "me" ? 0 : 8,
                  background: msg.side === "bot"
                    ? waBubbleBot
                    : msg.side === "me"
                      ? waBubbleMe
                      : waBubbleOther,
                  maxWidth: "88%",
                  border: msg.side === "bot" ? `1px solid ${waBotBorder}33` : "none",
                  position: "relative",
                }}>
                  <div style={{
                    fontSize: 13,
                    lineHeight: 1.45,
                    whiteSpace: "pre-line",
                    color: waText,
                    paddingBottom: 14,
                  }}>
                    {msg.text}
                  </div>
                  {/* Timestamp */}
                  <span style={{
                    position: "absolute",
                    bottom: 3,
                    right: dir === "rtl" ? "auto" : 7,
                    left: dir === "rtl" ? 7 : "auto",
                    fontSize: 10,
                    color: waTime,
                  }}>
                    {msg.time}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Feature pills */}
        <div style={{
          width: "100%",
          maxWidth: 340,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          paddingBottom: 8,
        }}>
          {features.map((f, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                background: "var(--white)",
                borderRadius: 13,
                border: "1.5px solid var(--border)",
                animation: `msgIn 0.3s ease ${0.6 + i * 0.1}s both`,
              }}
            >
              <span style={{ flexShrink: 0, color: "var(--accent)", display: "flex", alignItems: "center" }}>{f.icon}</span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--dark)", marginBottom: 1 }}>{f.title}</div>
                <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 300, lineHeight: 1.4 }}>{f.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sticky bottom CTA — always visible */}
      <div style={{
        padding: "12px 20px 20px",
        background: "var(--cream)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        flexShrink: 0,
      }}>
        <button
          onClick={onGetStarted}
          style={{
            width: "100%",
            maxWidth: 340,
            padding: 15,
            borderRadius: 14,
            background: "var(--dark)",
            color: "var(--white)",
            border: "none",
            cursor: "pointer",
            fontSize: 15,
            fontWeight: 500,
            fontFamily: "inherit",
            transition: "background 0.2s",
            marginBottom: 8,
          }}
        >
          {isHe ? "בואו נתחיל ←" : "Get started →"}
        </button>

        <button
          onClick={onSignIn}
          style={{
            background: "none",
            border: "none",
            color: "var(--muted)",
            fontSize: 12.5,
            cursor: "pointer",
            fontFamily: "inherit",
            padding: 6,
          }}
        >
          {isHe ? "יש לי כבר חשבון — התחברות" : "Already have an account — Sign in"}
        </button>
      </div>
    </div>
  );
}
