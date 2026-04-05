import { useState } from "react";
import "../styles/landing.css";
import { ShoppingFeatureIcon, CalendarFeatureIcon, ChoresFeatureIcon, ChevronRightIcon } from "./Icons.jsx";

const WA_LINK = "https://wa.me/972555175553";

const MOCK_MESSAGES = [
  { sender: "אמא", text: "חלב, ביצים ולחם", type: "user" },
  { sender: "שלי", text: "\u{1F6D2} הוספתי חלב, ביצים ולחם לרשימה", type: "bot" },
  { sender: "אבא", text: "מישהו יכול לאסוף את נועה מחוג ב-5?", type: "user" },
  { sender: "שלי", text: "\u{1F4C5} הוספתי: לאסוף את נועה ב-17:00, מי יכול?", type: "bot" },
  { sender: "אמא", text: "אני", type: "user" },
  { sender: "שלי", text: "\u2705 סימנתי לאמא", type: "bot" },
];

const FEATURES = [
  {
    Icon: ShoppingFeatureIcon,
    title: "רשימת קניות",
    subtitle: 'אמרו "חלב" בקבוצה וזה ברשימה. בלי אפליקציה, בלי הקלדה',
  },
  {
    Icon: CalendarFeatureIcon,
    title: "חוגים, הסעות ואירועים",
    subtitle: "שלי מזהה תאריכים ומארגנת את היומן המשפחתי",
  },
  {
    Icon: ChoresFeatureIcon,
    title: "מטלות בית",
    subtitle: "מי עושה מה ומתי, שלי זוכרת ומעדכנת",
  },
];

const STEPS = [
  {
    title: "הוסיפו את שלי לקבוצת הווטסאפ",
    subtitle: "לחצו על הכפתור ושלי מצטרפת לקבוצה שלכם",
  },
  {
    title: "דברו כרגיל",
    subtitle: "שלי מבינה עברית טבעית: קניות, מטלות, אירועים",
  },
  {
    title: "הכל מסתדר",
    subtitle: "הרשימה, היומן והמטלות מתעדכנים אוטומטית",
  },
];

const FAQ_ITEMS = [
  {
    q: "האם שלי קוראת את כל ההודעות?",
    a: "שלי מזהה רק הודעות שקשורות למטלות, קניות ואירועים. שיחות חברתיות, תמונות ומדיה? שלי מתעלמת לחלוטין.",
  },
  {
    q: "כמה זה עולה?",
    a: "30 פעולות בחודש חינם. Premium ב-9.90 \u20AA לחודש, ללא הגבלה.",
  },
  {
    q: "האם זה עובד בקבוצות קיימות?",
    a: "כן! פשוט הוסיפו את שלי לכל קבוצת ווטסאפ.",
  },
  {
    q: "מה שלי יודעת לעשות?",
    a: "רשימות קניות, מטלות בית, אירועים ביומן, תזכורות, ומענה לשאלות על מה שצריך לעשות.",
  },
];

const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
);

export default function LandingPage({ onGetStarted, onSignIn }) {
  const [openFaq, setOpenFaq] = useState(null);

  return (
    <div className="landing">
      {/* ─── Hero ─── */}
      <section className="landing-hero">
        <h1 className="landing-wordmark">Sheli</h1>
        <p className="landing-tagline">
          העוזרת החכמה של הבית בווטסאפ שלכם
        </p>

        {/* WhatsApp Mock */}
        <div className="wa-mock">
          <div className="wa-mock-header">
            <div className="wa-mock-avatar">👨‍👩‍👧</div>
            <div className="wa-mock-group-info">
              <span className="wa-mock-group-name">משפחת כהן</span>
              <span className="wa-mock-group-members">אמא, אבא, נועה, איתי, שלי</span>
            </div>
          </div>
          <div className="wa-mock-chat">
            {MOCK_MESSAGES.map((msg, i) => (
              <div
                key={i}
                className={`wa-bubble wa-bubble-${msg.type}`}
                style={{ animationDelay: `${i * 0.15}s` }}
              >
                <span className={`wa-bubble-sender wa-bubble-sender-${msg.type}`}>
                  {msg.sender}
                </span>
                {msg.text}
                <span className="wa-bubble-time">
                  {`${14 + Math.floor(i / 2)}:${i % 2 === 0 ? "32" : "33"}`}
                </span>
              </div>
            ))}
          </div>
        </div>

        <a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="landing-cta">
          <WhatsAppIcon />
          הוסיפו את שלי לקבוצה
        </a>
        <button className="landing-signin" onClick={onSignIn}>
          יש לי כבר חשבון &larr; כניסה
        </button>
      </section>

      {/* ─── Features ─── */}
      <section className="landing-features">
        <h2 className="landing-section-title">מה שלי יודעת לעשות</h2>
        <div className="feature-cards">
          {FEATURES.map((f, i) => (
            <div key={i} className="feature-card">
              <div className="feature-card-icon">
                <f.Icon size={22} />
              </div>
              <div className="feature-card-text">
                <h3>{f.title}</h3>
                <p>{f.subtitle}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── How It Works ─── */}
      <section className="landing-steps">
        <h2 className="landing-section-title">איך זה עובד</h2>
        <div className="steps-list">
          {STEPS.map((s, i) => (
            <div key={i} className="step-item">
              <div className="step-number">{i + 1}</div>
              <div className="step-text">
                <h3>{s.title}</h3>
                <p>{s.subtitle}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── FAQ ─── */}
      <section className="landing-faq">
        <h2 className="landing-section-title">שאלות נפוצות</h2>
        <div className="faq-list">
          {FAQ_ITEMS.map((faq, i) => (
            <div key={i} className="faq-item">
              <button
                className="faq-question"
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
              >
                <span>{faq.q}</span>
                <ChevronRightIcon
                  size={16}
                  className={`faq-chevron ${openFaq === i ? "open" : ""}`}
                />
              </button>
              <div className={`faq-answer ${openFaq === i ? "open" : ""}`}>
                {faq.a}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Bottom CTA ─── */}
      <section className="landing-bottom-cta">
        <h2 className="landing-section-title">מוכנים להתחיל?</h2>
        <a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="landing-cta">
          <WhatsAppIcon />
          הוסיפו את שלי לקבוצה
        </a>
        <button className="landing-app-link" onClick={onGetStarted}>
          או היכנסו לאפליקציה
        </button>
      </section>
    </div>
  );
}
