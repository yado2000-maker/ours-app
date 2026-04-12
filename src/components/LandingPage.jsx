import { useState } from "react";
import "../styles/landing.css";
import {
  ShoppingFeatureIcon,
  CalendarFeatureIcon,
  ChoresFeatureIcon,
  ReminderFeatureIcon,
  LearningFeatureIcon,
  ChevronRightIcon,
} from "./Icons.jsx";

const WA_LINK = "https://wa.me/972555175553?text=" + encodeURIComponent("היי שלי!");

// ─── Bilingual content ───
// Rethought for "personal + family" positioning (One Sheli, One Price).
// Mock shows 1:1 personal chat (universal entry point), not a family group.
// All CTAs use plural gender-free forms. No family-only framing.

const CONTENT = {
  he: {
    dir: "rtl",
    font: "'Heebo', sans-serif",
    tagline: "העוזרת החכמה שלכם בווטסאפ",
    mockChatName: "שלי",
    mockStatus: "מחוברת",
    mockAvatar: "ש",
    mockMessages: [
      { text: "חלב, ביצים ולחם", type: "user" },
      { text: "\u{1F6D2} הוספתי לרשימה!", type: "bot" },
      { text: "תזכירי לי מחר לשלם חשבון חשמל", type: "user" },
      { text: "\u{1F514} בשמחה! אזכיר לך מחר ב-9 בבוקר", type: "bot" },
      { type: "voice", duration: "0:12" },
      { text: "\u{1F4C5} הוספתי ליומן: ארוחת ערב אצל סבא וסבתא ביום שישי", type: "bot" },
    ],
    cta: "שלחו הודעה לשלי",
    freeBadge: "חינם לגמרי · עד 30 פעולות בחודש · בלי כרטיס אשראי",
    qrLabel: "או סרקו את הקוד",
    signin: "יש לי כבר חשבון \u2190 כניסה",
    featuresTitle: "מה שלי יודעת לעשות?",
    features: [
      { Icon: ShoppingFeatureIcon, title: "רשימת קניות", subtitle: "כתבו \u0022חלב\u0022 לשלי והיא מוסיפה לרשימה. בלי אפליקציה, בלי הקלדה" },
      { Icon: ReminderFeatureIcon, title: "תזכורות חכמות", subtitle: "\u0022שלי, תזכירי לי...\u0022 והיא מזכירה בזמן. גם דברים שחוזרים כל שבוע" },
      { Icon: CalendarFeatureIcon, title: "יומן ואירועים", subtitle: "שלי מזהה תאריכים ומארגנת את היומן שלכם" },
      { Icon: ChoresFeatureIcon, title: "משימות ומטלות", subtitle: "נהלו את המשימות ואת מטלות הבית. שלי זוכרת ומעדכנת" },
      { Icon: LearningFeatureIcon, title: "שלי לומדת אתכם", subtitle: "ככל שתשתמשו יותר, שלי מבינה אתכם טוב יותר. כינויים, מוצרים, הרגלים" },
    ],
    stepsTitle: "איך זה עובד?",
    steps: [
      { title: "שלחו הודעה לשלי בווטסאפ", subtitle: "טקסט או הודעה קולית, שלי מבינה הכל" },
      { title: "כתבו מהבית", subtitle: "\u0022חלב ולחם\u0022 וזה ברשימה. \u0022תזכירי לי מחר\u0022 והיא מזכירה. קניות, מטלות, אירועים" },
      { title: "הקליטו מהדרך", subtitle: "בדרך לסופר? \u0022שלי, מה ברשימה היום?\u0022 והיא עונה מיד" },
    ],
    faqTitle: "שאלות נפוצות",
    faq: [
      { q: "איך שלי עובדת?", a: "שלי היא עוזרת חכמה בווטסאפ שמבינה עברית טבעית. כתבו \u0022חלב\u0022 והיא תוסיף לרשימה, \u0022תזכירי לי...\u0022 והיא תזכיר בזמן. שלי עובדת בצ\u0027אט אישי ובקבוצות, לבד או עם כל מי שגר איתכם. היא לומדת את הסגנון שלכם עם הזמן: כינויים, מוצרים קבועים, הרגלים." },
      { q: "יש גם אפליקציה?", a: "כן! לשלי יש אפליקציה נהדרת! רשימת הקניות, המטלות ולוח האירועים מתעדכנים בזמן אמת, גם מהווטסאפ וגם מהאפליקציה. היכנסו: sheli.ai" },
      { q: "כמה זה עולה?", a: "חינם לגמרי עד 30 פעולות בחודש, כל חודש!\nצריכים יותר? פרימיום ללא הגבלה ב-9.90 \u20AA לחודש בלבד." },
      { q: "מה עם הפרטיות?", a: "שלי לא שומרת תמונות או וידאו. הודעות קוליות קצרות? שלי שומעת ומבינה, אבל לא שומרת את ההקלטה, רק את התוכן, בדיוק כמו הודעה רגילה. כל המידע נמחק אחרי 30 יום. רק אתם רואים את המידע שלכם. אף אחד אחר, כולל אותנו." },
      { q: "איך מתחילים? ואיך מפסיקים?", a: "שלחו הודעה לשלי בווטסאפ, היא מתחילה לעזור מיד. רוצים שכולם בבית ישתתפו? הוסיפו אותה לקבוצת ווטסאפ. רוצים להפסיק? פשוט תפסיקו לכתוב. כל המידע נמחק אוטומטית, בלי התחייבות." },
      { q: "למי שלי מתאימה?", a: "לכולם! גרים לבד? שלי מנהלת לכם קניות, תזכורות וסידורים. עם שותפים? הוסיפו אותה לקבוצת הדירה והיא תתאם מי קונה, מי מנקה, הכל. משפחה? שלי מנהלת את כל הבית." },
    ],
    bottomTitle: "מוכנים להתחיל?",
    bottomLink: "קחו אותי לאפליקציה",
    bottomOr: "או",
    langToggle: "EN",
  },
  en: {
    dir: "ltr",
    font: "'Nunito', sans-serif",
    tagline: "Your smart helper on WhatsApp",
    mockChatName: "Sheli",
    mockStatus: "online",
    mockAvatar: "S",
    mockMessages: [
      { text: "Milk, bread and eggs", type: "user" },
      { text: "\u{1F6D2} Added to the list!", type: "bot" },
      { text: "Remind me to pay the electric bill tomorrow", type: "user" },
      { text: "\u{1F514} Sure! I'll remind you tomorrow at 9am", type: "bot" },
      { type: "voice", duration: "0:12" },
      { text: "\u{1F4C5} Added to calendar: dinner at grandma's on Friday at 7pm", type: "bot" },
    ],
    cta: "Message Sheli",
    freeBadge: "Completely free \u00B7 Up to 30 actions/month \u00B7 No credit card",
    qrLabel: "or scan the code",
    signin: "I have an account \u2192 Sign in",
    featuresTitle: "What can Sheli do?",
    features: [
      { Icon: ShoppingFeatureIcon, title: "Shopping lists", subtitle: "Text \u0022milk\u0022 to Sheli and it's on the list. No app needed." },
      { Icon: ReminderFeatureIcon, title: "Smart reminders", subtitle: "\u0022Sheli, remind me...\u0022 and she'll remind you on time. Even recurring ones." },
      { Icon: CalendarFeatureIcon, title: "Calendar & events", subtitle: "Sheli spots dates and organizes your schedule" },
      { Icon: ChoresFeatureIcon, title: "Tasks & chores", subtitle: "Manage your tasks and your house chores. Sheli remembers and updates" },
      { Icon: LearningFeatureIcon, title: "Sheli learns you", subtitle: "The more you use her, the better she gets. Nicknames, products, routines" },
    ],
    stepsTitle: "How does it work?",
    steps: [
      { title: "Send Sheli a message on WhatsApp", subtitle: "Text or voice message, Sheli understands both" },
      { title: "Type from home", subtitle: "\u0022Milk and bread\u0022 and it's on the list. \u0022Remind me tomorrow\u0022 and she will. Shopping, tasks, events" },
      { title: "Send a voice note on the go", subtitle: "Driving to the store? \u0022Sheli, what's on my list?\u0022 and she answers right away" },
    ],
    faqTitle: "FAQ",
    faq: [
      { q: "How does Sheli work?", a: "Sheli is a smart WhatsApp assistant that understands natural language. Say \u0022milk\u0022 and it's on the list, say \u0022remind me...\u0022 and she'll remind you on time. Sheli works in private chat and in groups, alone or with everyone in your home. She learns your style over time: nicknames, regular products, routines." },
      { q: "Is there also an app?", a: "Yes! Sheli has a great app! Your shopping list, tasks and calendar sync in real time, from both WhatsApp and the app. Visit: sheli.ai" },
      { q: "How much does it cost?", a: "30 actions per month for free, every month!\nNeed more? Unlimited Premium for just $2.70/month." },
      { q: "What about privacy?", a: "Sheli doesn't store photos or videos. Short voice messages? Sheli listens and understands, but doesn't save the recording, only the content, just like a text message. All data is deleted after 30 days. Only you can see your data. Nobody else, including us." },
      { q: "How do I start? And stop?", a: "Send Sheli a message on WhatsApp, she starts helping right away. Want everyone at home to join? Add her to a WhatsApp group. Want to stop? Just stop writing. All data is deleted automatically, no strings attached." },
      { q: "Who is Sheli for?", a: "Everyone! Living alone? Sheli manages your shopping, reminders and daily tasks. Roommates? Add her to the apartment group and she'll coordinate who buys, who cleans, everything. Family? Sheli manages the whole household." },
    ],
    bottomTitle: "Ready to get started?",
    bottomLink: "Take me to the app",
    bottomOr: "or",
    langToggle: "\u05E2\u05D1",
  },
};

const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
);

export default function LandingPage({ onGetStarted, onSignIn }) {
  const [openFaq, setOpenFaq] = useState(null);
  const [lang, setLang] = useState("he");
  const c = CONTENT[lang];

  const handleSignIn = () => onSignIn(lang);
  const handleGetStarted = () => onGetStarted(lang);

  return (
    <div className="landing" style={{ direction: c.dir, fontFamily: c.font }}>
      {/* ─── Language Toggle ─── */}
      <button
        className="landing-lang-toggle"
        onClick={() => { setLang(lang === "he" ? "en" : "he"); setOpenFaq(null); }}
      >
        {c.langToggle}
      </button>

      {/* ─── Hero ─── */}
      <section className="landing-hero">
        <h1 className="landing-wordmark">sheli</h1>
        <p className="landing-tagline">{c.tagline}</p>

        {/* WhatsApp Mock — 1:1 personal chat */}
        <div className="wa-mock">
          <div className="wa-mock-header">
            <div className="wa-mock-avatar wa-mock-avatar-sheli">{c.mockAvatar}</div>
            <div className="wa-mock-contact-info">
              <span className="wa-mock-contact-name">{c.mockChatName}</span>
              <span className="wa-mock-contact-status">{c.mockStatus}</span>
            </div>
          </div>
          <div className="wa-mock-chat">
            {c.mockMessages.map((msg, i) => (
              <div
                key={i}
                className={`wa-bubble wa-bubble-${msg.type === "voice" ? "user" : msg.type}`}
                style={{ animationDelay: `${i * 0.15}s`, direction: c.dir }}
              >
                {msg.type === "voice" ? (
                  <span className="wa-voice">
                    <span className="wa-voice-avatar">
                      <img src="/voice-avatar.svg" alt="" className="wa-voice-avatar-img" />
                      <span className="wa-voice-mic-badge">
                        <svg viewBox="0 0 12 12" fill="#fff"><path d="M6 7.5A1.5 1.5 0 0 0 7.5 6V3a1.5 1.5 0 1 0-3 0v3A1.5 1.5 0 0 0 6 7.5zm2.5-1.5A2.5 2.5 0 0 1 6 8.5 2.5 2.5 0 0 1 3.5 6H3a3 3 0 0 0 2.5 2.96V10h1V8.96A3 3 0 0 0 9 6h-.5z"/></svg>
                      </span>
                    </span>
                    <span className="wa-voice-content">
                      <span className="wa-voice-row">
                        <span className="wa-voice-play">\u25B6</span>
                        <span className="wa-voice-dot">\u25CF</span>
                        <span className="wa-voice-bars">
                          <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
                        </span>
                      </span>
                      <span className="wa-voice-dur">{msg.duration}</span>
                    </span>
                  </span>
                ) : msg.text}
                <span className="wa-bubble-time">
                  {`${14 + Math.floor(i / 2)}:${i % 2 === 0 ? "32" : "33"}`}
                </span>
              </div>
            ))}
          </div>
        </div>

        <a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="landing-cta">
          {c.cta}
          <WhatsAppIcon />
        </a>

        <div className="landing-free-badge">{c.freeBadge}</div>

        <a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="landing-qr">
          <img src="/qr-whatsapp.svg" alt="QR code to message Sheli on WhatsApp" width="140" height="140" />
          <span className="landing-qr-label">{c.qrLabel}</span>
        </a>

        <button className="landing-signin" onClick={handleSignIn}>
          {c.signin}
        </button>
      </section>

      {/* ─── Features (5 cards) ─── */}
      <section className="landing-features">
        <h2 className="landing-section-title">{c.featuresTitle}</h2>
        <div className="feature-cards">
          {c.features.map((f, i) => (
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
        <h2 className="landing-section-title">{c.stepsTitle}</h2>
        <div className="steps-list">
          {c.steps.map((s, i) => (
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
        <h2 className="landing-section-title">{c.faqTitle}</h2>
        <div className="faq-list">
          {c.faq.map((faq, i) => (
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
        <h2 className="landing-section-title">{c.bottomTitle}</h2>
        <a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="landing-cta">
          {c.cta}
          <WhatsAppIcon />
        </a>
        <span className="landing-bottom-or">{c.bottomOr}</span>
        <button className="landing-cta landing-cta-app" onClick={handleGetStarted}>
          {c.bottomLink}
        </button>
      </section>
    </div>
  );
}
