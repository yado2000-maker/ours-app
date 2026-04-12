import { useState } from "react";
import T from "../locales/index.js";
import { ShoppingFeatureIcon, CalendarFeatureIcon, ChoresFeatureIcon } from "./Icons.jsx";

// Welcome screen — shows value before asking for auth
// Flow: Language pick → Value prop → CTA → Auth
export default function WelcomeScreen({ onGetStarted, onSignIn }) {
  const [lang, setLang] = useState(null);
  const [step, setStep] = useState(0); // 0=lang, 1=value

  const t = lang ? T[lang] : T.en;
  const dir = lang === "he" ? "rtl" : "ltr";
  const isHe = lang === "he";
  const font = isHe ? "'Heebo',sans-serif" : "'Nunito',sans-serif";

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
        fontFamily: "'Nunito',sans-serif",
      }}>
        <div style={{
          fontFamily: "'Nunito',sans-serif",
          fontWeight: 800,
          fontSize: 42,
          letterSpacing: "0.04em",
          background: "linear-gradient(135deg, #E8725C, #D4507A)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          marginBottom: 8,
        }}>sheli</div>
        <p style={{
          fontSize: 14,
          color: "var(--muted)",
          fontWeight: 300,
          marginBottom: 48,
          letterSpacing: "0.03em",
        }}>Your smart helper on WhatsApp</p>

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

  // Mini WhatsApp mock — just 2 messages to show the concept
  const mockChat = isHe ? [
    { sender: "אמא", text: "מישהו יכול לאסוף את נועה מבלט ב-5?", side: "other", time: "09:12" },
    { sender: "שלי", text: "📅 הוספתי: לאסוף את נועה ב-17:00\nמי לוקח?", side: "bot", time: "09:12" },
  ] : [
    { sender: "Mom", text: "Can someone pick up Noa from ballet at 5?", side: "other", time: "9:12 AM" },
    { sender: "Sheli", text: "📅 Added: Pick up Noa at 5pm\nWho's taking this?", side: "bot", time: "9:12 AM" },
  ];

  const features = isHe ? [
    { icon: <ShoppingFeatureIcon size={22} />, title: "רשימת קניות חכמה", sub: "כתבו 'חלב' לשלי, והיא מוסיפה לרשימה בשנייה" },
    { icon: <CalendarFeatureIcon size={22} />, title: "הלו״ז שלנו", sub: "חוגים, הסעות, אירועים — מסודרים מעצמם" },
    { icon: <ChoresFeatureIcon size={22} />, title: "חלוקת מטלות", sub: "זוכרת מי צריך לעשות מה ומתי" },
  ] : [
    { icon: <ShoppingFeatureIcon size={22} />, title: "Smart shopping list", sub: "Text 'milk' to Sheli, on the list instantly" },
    { icon: <CalendarFeatureIcon size={22} />, title: "Our schedule", sub: "Classes, pickups, events — organized automatically" },
    { icon: <ChoresFeatureIcon size={22} />, title: "Task sharing", sub: "Remembers who does what and when" },
  ];

  // WhatsApp colors
  const waBg = "#0b141a";
  const waHeader = "#1f2c34";
  const waBubbleOther = "#1f2c34";
  const waBubbleBot = "#103529";
  const waBotBorder = "#25D366";
  const waText = "#e9edef";
  const waTextMuted = "#8696a0";
  const waTime = "#8696a0";

  // Step 1: Value proposition — compact layout, everything above the fold
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
      {/* Scrollable content — centers on tall screens, scrolls on short ones */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "20px 20px 12px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}>
        {/* Wordmark + tagline */}
        <div style={{
          fontFamily: "'Nunito',sans-serif",
          fontWeight: 800,
          fontSize: 28,
          letterSpacing: "0.04em",
          background: "linear-gradient(135deg, #E8725C, #D4507A)",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          marginBottom: 4,
        }}>sheli</div>

        <p style={{
          fontSize: 15,
          color: "var(--dark)",
          fontWeight: 500,
          textAlign: "center",
          lineHeight: 1.5,
          maxWidth: 300,
          marginBottom: 16,
        }}>
          {isHe
            ? "העוזרת החכמה שלכם בווטסאפ"
            : "Your smart helper on WhatsApp"}
        </p>

        {/* Compact WhatsApp mock — just 2 messages */}
        <div style={{
          width: "100%",
          maxWidth: 320,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 2px 16px rgba(0,0,0,0.12)",
          marginBottom: 20,
        }}>
          {/* Mini header */}
          <div style={{
            background: waHeader,
            padding: "7px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            direction: "ltr",
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: "50%",
              background: "#2a3942",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12,
            }}>👥</div>
            <div style={{ direction: dir, textAlign: "start" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, color: waText }}>
                {isHe ? "הקבוצה של הבית" : "Home Group"}
              </div>
              <div style={{ fontSize: 10, color: waTextMuted }}>
                {isHe ? "אמא, אבא, שלי, את/ה" : "Mom, Dad, Sheli, You"}
              </div>
            </div>
          </div>

          {/* Chat — compact */}
          <div style={{
            background: waBg,
            backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
            padding: "8px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}>
            {mockChat.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: msg.side === "me" ? "flex-end" : "flex-start",
                  animation: `msgIn 0.3s ease ${i * 0.15}s both`,
                  direction: "ltr",
                }}
              >
                {msg.side !== "me" && (
                  <span style={{
                    fontSize: 10,
                    fontWeight: 500,
                    color: msg.side === "bot" ? "#25D366" : "#53bdeb",
                    marginBottom: 1,
                    padding: "0 5px",
                    direction: dir,
                  }}>
                    {msg.sender}
                  </span>
                )}
                <div style={{
                  padding: "5px 7px 3px",
                  borderRadius: 7,
                  borderTopLeftRadius: msg.side === "me" ? 7 : 0,
                  borderTopRightRadius: msg.side === "me" ? 0 : 7,
                  background: msg.side === "bot" ? waBubbleBot : msg.side === "me" ? "#005c4b" : waBubbleOther,
                  maxWidth: "88%",
                  border: msg.side === "bot" ? `1px solid ${waBotBorder}33` : "none",
                  position: "relative",
                }}>
                  <div style={{
                    fontSize: 12,
                    lineHeight: 1.4,
                    whiteSpace: "pre-line",
                    color: waText,
                    paddingBottom: 12,
                    direction: dir,
                    textAlign: "start",
                  }}>
                    {msg.text}
                  </div>
                  <span style={{
                    position: "absolute",
                    bottom: 2,
                    right: 6,
                    fontSize: 9,
                    color: waTime,
                  }}>
                    {msg.time}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Feature rows — compact */}
        <div style={{
          width: "100%",
          maxWidth: 320,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}>
          {features.map((f, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: "var(--white)",
                borderRadius: 12,
                border: "1.5px solid var(--border)",
                animation: `msgIn 0.25s ease ${0.3 + i * 0.08}s both`,
              }}
            >
              <span style={{ flexShrink: 0, color: "var(--accent)", display: "flex", alignItems: "center" }}>{f.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--dark)" }}>{f.title}</div>
                <div style={{ fontSize: 11, color: "var(--muted)", fontWeight: 300, lineHeight: 1.35 }}>{f.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sticky bottom CTA */}
      <div style={{
        padding: "10px 20px 16px",
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
            maxWidth: 320,
            padding: 14,
            borderRadius: 999,
            background: "var(--dark)",
            color: "var(--white)",
            border: "none",
            cursor: "pointer",
            fontSize: 15,
            fontWeight: 500,
            fontFamily: "inherit",
            transition: "background 0.2s",
            marginBottom: 6,
          }}
        >
          {isHe ? "← בואו נתחיל" : "Get started →"}
        </button>

        <button
          onClick={onSignIn}
          style={{
            background: "none",
            border: "none",
            color: "var(--muted)",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "inherit",
            padding: 4,
          }}
        >
          {isHe ? "יש לי כבר חשבון — התחברות" : "Already have an account — Sign in"}
        </button>
      </div>
    </div>
  );
}
