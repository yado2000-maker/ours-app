import { useState } from "react";
import "../styles/landing.css";
import {
  ShoppingFeatureIcon,
  CalendarFeatureIcon,
  ChoresFeatureIcon,
  ReminderFeatureIcon,
  ForwardFeatureIcon,
  ExpenseFeatureIcon,
  FamilyGroupIcon,
  KidsIcon,
  ChevronRightIcon,
} from "./Icons.jsx";

// During recovery period: CTA goes to /waitlist instead of WhatsApp.
// Flip back to WA_LINK once Cloud API migration is live.
const WAITLIST_LINK = "/waitlist?source=landing_cta";

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
    mockMessages: [
      { text: "חלב, ביצים ולחם", type: "user" },
      { text: "\u{1F6D2} הוספתי לרשימה!", type: "bot" },
      { text: "תזכירי לי מחר לשלם חשבון חשמל", type: "user" },
      { text: "\u{1F514} בשמחה! אזכיר לך מחר ב-9 בבוקר", type: "bot" },
      { type: "voice", duration: "0:12" },
      { text: "\u{1F4C5} הוספתי ליומן: ארוחת ערב אצל סבא וסבתא ביום שישי", type: "bot" },
    ],
    cta: "הצטרפו לרשימת ההמתנה",
    freeBadge: "שלי קולטת מצטרפים חדשים בהדרגה · השאירו פרטים ושלי תחזור אליכם ברגע שיגיע תורכם",
    bridge: ["רק לעצמך או לכל המשפחה ביחד", "שלי עושה סדר בחיים"],
    signin: "יש לי כבר חשבון \u2190 כניסה",
    featuresTitle: "מה שלי יודעת לעשות?",
    features: [
      { Icon: ShoppingFeatureIcon, title: "רשימת קניות", subtitle: "כתבו \u0022חלב\u0022 לשלי והיא מוסיפה לרשימה. בלי אפליקציה, בלי הקלדה" },
      { Icon: ReminderFeatureIcon, title: "תזכורות חכמות", subtitle: "\u0022שלי, תזכירי לי...\u0022 והיא מזכירה בזמן. גם דברים שחוזרים כל שבוע" },
      { Icon: CalendarFeatureIcon, title: "יומן ואירועים", subtitle: "שלי מזהה תאריכים ומארגנת את היומן שלכם" },
      { Icon: ChoresFeatureIcon, title: "ניהול משימות ומטלות - גם לילדים!", subtitle: "תור מי לפנות מדיח? ומי אוסף מהחוג? מושלם להורים עסוקים" },
      { Icon: ExpenseFeatureIcon, title: "מעקב הוצאות", subtitle: "\u0022שילמתי 85 על פיצה\u0022 — ושלי רושמת. עוקבת אחרי הוצאות ומעדכנת אתכם כשתרצו" },
      { Icon: ForwardFeatureIcon, title: "העברה אליי בלחיצה", subtitle: "לחצו \u0022העבר\u0022 על כל הודעה עם תאריך, רשימה או פרטי אירוע - ואני אוסיף אוטומטית. בלי להקליד מחדש" },
    ],
    familyTitle: "שלי לכל המשפחה",
    familyItems: [
      { Icon: ShoppingFeatureIcon, title: "רשימת קניות משותפת", subtitle: "אבא מוסיף חלב מהעבודה, אמא מוסיפה ביצים מהדרך, והילדים מוסיפים נוטלה. הכל ברשימה אחת" },
      { Icon: KidsIcon, title: "מטלות בית ותורנויות", subtitle: "תור מי להיות ראשון במקלחת? סוף לריבים בין הילדים, שלי זוכרת ומעדכנת" },
      { Icon: FamilyGroupIcon, title: "הוסיפו את שלי לקבוצה", subtitle: "הוסיפו את שלי לקבוצת ווטסאפ של המשפחה — וכולם מסודרים" },
    ],
    stepsTitle: "איך זה עובד?",
    steps: [
      { title: "שלחו הודעה לשלי בווטסאפ", subtitle: "טקסט או הודעה קולית, שלי מבינה הכל" },
      { title: "כתבו בעברית פשוטה", subtitle: "\u0022חלב ולחם\u0022 וזה ברשימת הקניות. \u0022תזכירי לי מחר\u0022 והתזכורת מופעלת. בלי אפליקציות מיותרות" },
      { title: "הקליטו מהדרך", subtitle: "בדרך לסופר? \u0022שלי, מה ברשימה היום?\u0022 והיא עונה מיד" },
    ],
    faqTitle: "שאלות נפוצות",
    faq: [
      { q: "איך שלי עובדת?", a: "שלי היא פיתוח ישראלי שמארגן לכם את הבית דרך ווטסאפ - רשימות קניות, תזכורות, מטלות, יומן והוצאות, הכל במקום אחד. כתבו \u0022חלב\u0022 והיא תוסיף לרשימה, \u0022תזכירי לי...\u0022 והיא תזכיר בזמן. שלי עובדת בצ\u0027אט אישי ובקבוצות, לבד או עם כל מי שגר בבית. היא זוכרת את הסגנון שלכם עם הזמן: כינויים, מוצרים קבועים, הרגלים." },
      { q: "אפליקציה לצפייה נוחה בכל הרשימות שלכם", a: "רשימת הקניות, המטלות, התזכורות, התקציב ולוח האירועים מתעדכנים בזמן אמת, גם מהווטסאפ וגם מהאפליקציה - אין יותר נוח מזה!" },
      { q: "כמה זה עולה?", a: "חינם לגמרי עד 40 פעולות בחודש, כל חודש!\nצריכים יותר? הצטרפו לשלי פרימיום ללא הגבלה ב-14.90 \u20AA לחודש בלבד\nאו 149 \u20AA לשלי פרימיום לשנה שלמה (חודשיים במתנה!)" },
      { q: "מה עם הפרטיות?", a: "שלי שומרת למשך 30 יום את הודעות הטקסט ואת ההודעות הקוליות הקצרות שתשלחו אליה. היא לא שומרת תמונות או וידאו. לאחר 30 יום, כל המידע נמחק אלא אם תבקשו אחרת משלי. המידע שלכם שמור ומאובטח ורק אתם רואים אותו. אף אחד אחר לא - כולל אותנו." },
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
    mockMessages: [
      { text: "Milk, bread and eggs", type: "user" },
      { text: "\u{1F6D2} Added to the list!", type: "bot" },
      { text: "Remind me to pay the electric bill tomorrow", type: "user" },
      { text: "\u{1F514} Sure! I'll remind you tomorrow at 9am", type: "bot" },
      { type: "voice", duration: "0:12" },
      { text: "\u{1F4C5} Added to calendar: dinner at grandma's on Friday at 7pm", type: "bot" },
    ],
    cta: "Join the waitlist",
    freeBadge: "Sheli is welcoming new signups in small batches \u00B7 Leave your details and we'll reach out when it's your turn",
    bridge: ["Just for you or the whole family", "Sheli keeps it all together"],
    signin: "I have an account \u2192 Sign in",
    featuresTitle: "What can Sheli do?",
    features: [
      { Icon: ShoppingFeatureIcon, title: "Shopping lists", subtitle: "Text \u0022milk\u0022 to Sheli and it's on the list. No app needed." },
      { Icon: ReminderFeatureIcon, title: "Smart reminders", subtitle: "\u0022Sheli, remind me...\u0022 and she'll remind you on time. Even recurring ones." },
      { Icon: CalendarFeatureIcon, title: "Calendar & events", subtitle: "Sheli spots dates and organizes your schedule" },
      { Icon: ChoresFeatureIcon, title: "Tasks & chores \u2014 for kids too!", subtitle: "Whose turn to empty the dishwasher? Who picks up from practice? Perfect for busy parents" },
      { Icon: ExpenseFeatureIcon, title: "Expense tracking", subtitle: "\u0022I paid 85 for pizza\u0022 — and Sheli logs it. Tracks expenses and updates you when you want" },
      { Icon: ForwardFeatureIcon, title: "Forward it to Sheli", subtitle: "Tap \u0022Forward\u0022 on any message with a date, list, or event details — I'll add it automatically. No retyping" },
    ],
    familyTitle: "Sheli for the whole family",
    familyItems: [
      { Icon: ShoppingFeatureIcon, title: "Shared shopping list", subtitle: "Dad adds milk from work, mom adds eggs on the go, and the kids add Nutella. One list for everyone" },
      { Icon: KidsIcon, title: "Chores & rotations", subtitle: "Whose turn to shower first? No more fights between the kids \u2014 Sheli remembers and updates" },
      { Icon: FamilyGroupIcon, title: "Add Sheli to your group", subtitle: "Add Sheli to your family WhatsApp group — everyone stays organized" },
    ],
    stepsTitle: "How does it work?",
    steps: [
      { title: "Send Sheli a message on WhatsApp", subtitle: "Text or voice message, Sheli understands both" },
      { title: "Just type naturally", subtitle: "\u0022Milk and bread\u0022 and it's on the shopping list. \u0022Remind me tomorrow\u0022 and the reminder is set. No extra apps needed" },
      { title: "Send a voice note on the go", subtitle: "Driving to the store? \u0022Sheli, what's on my list?\u0022 and she answers right away" },
    ],
    faqTitle: "FAQ",
    faq: [
      { q: "How does Sheli work?", a: "Sheli is a family task coordination helper on WhatsApp — shopping lists, reminders, chores, calendar and expenses, all in one place. Say \u0022milk\u0022 and it's on the list, say \u0022remind me...\u0022 and she'll remind you on time. Sheli works in private chat and in groups, alone or with everyone in your home. She remembers your style over time: nicknames, regular products, routines." },
      { q: "An app for easy viewing of all your lists", a: "Your shopping list, tasks, reminders, budget and calendar sync in real time, from both WhatsApp and the app \u2014 it doesn't get easier than this!" },
      { q: "How much does it cost?", a: "40 actions per month for free, every month!\nNeed more? Join Sheli Premium — unlimited for just 14.90 \u20AA/month\nor 149 \u20AA for a full year of Sheli Premium (2 months free!)" },
      { q: "What about privacy?", a: "Sheli stores text messages and short voice messages you send her for 30 days. She doesn't store photos or videos. After 30 days, all data is deleted unless you ask Sheli otherwise. Your data is secure and only you can see it. Nobody else \u2014 including us." },
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
        <p className="landing-bridge">{c.bridge[0]}<br />{c.bridge[1]}</p>

        {/* WhatsApp Mock — 1:1 personal chat */}
        <div className="wa-mock">
          <div className="wa-mock-header">
            <img src="/icons/icon-192.png" alt="Sheli" className="wa-mock-avatar wa-mock-avatar-sheli" />
            <div className="wa-mock-contact-info">
              <span className="wa-mock-contact-name">{c.mockChatName}</span>
              <span className="wa-mock-contact-status">{c.mockStatus}</span>
            </div>
          </div>
          <div className="wa-mock-chat">
            {c.mockMessages.map((msg, i) => (
              <div
                key={i}
                className={`wa-bubble wa-bubble-${msg.type === "voice" ? "user wa-bubble-voice" : msg.type}`}
                style={{ animationDelay: `${i * 0.15}s`, direction: msg.type === "voice" ? "ltr" : c.dir }}
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
                        <span className="wa-voice-play">{"\u25B6"}</span>
                        <span className="wa-voice-dot">{"\u25CF"}</span>
                        <span className="wa-voice-bars">
                          <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
                        </span>
                      </span>
                      <span className="wa-voice-meta">
                        <span className="wa-voice-dur">{msg.duration}</span>
                        <span className="wa-bubble-time">
                          {`${14 + Math.floor(i / 2)}:${i % 2 === 0 ? "32" : "33"}`}
                        </span>
                      </span>
                    </span>
                  </span>
                ) : (
                  <>
                    {msg.text}
                    <span className="wa-bubble-time">
                      {`${14 + Math.floor(i / 2)}:${i % 2 === 0 ? "32" : "33"}`}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        <a href={WAITLIST_LINK} className="landing-cta">
          {c.cta}
        </a>

        <div className="landing-free-badge">{c.freeBadge}</div>

        <button className="landing-signin" onClick={handleSignIn}>
          {c.signin}
        </button>
      </section>

      {/* ─── Features (6 cards) ─── */}
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

      {/* ─── Sheli for the Family ─── */}
      <section className="landing-family">
        <h2 className="landing-section-title">{c.familyTitle}</h2>
        <div className="family-items">
          {c.familyItems.map((item, i) => (
            <div key={i} className="family-item">
              <div className="family-item-icon">
                <item.Icon size={22} />
              </div>
              <div className="family-item-text">
                <h3>{item.title}</h3>
                <p>{item.subtitle}</p>
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
        <a href={WAITLIST_LINK} className="landing-cta">
          {c.cta}
        </a>
        <span className="landing-bottom-or">{c.bottomOr}</span>
        <button className="landing-cta landing-cta-app" onClick={handleGetStarted}>
          {c.bottomLink}
        </button>
      </section>
    </div>
  );
}
