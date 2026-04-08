import { useState } from "react";
import "../styles/landing.css";
import { ShoppingFeatureIcon, CalendarFeatureIcon, ChoresFeatureIcon, ChevronRightIcon } from "./Icons.jsx";

const WA_LINK = "https://wa.me/972555175553?text=" + encodeURIComponent("היי שלי!");

// ─── Bilingual content ───

const CONTENT = {
  he: {
    dir: "rtl",
    font: "'Heebo', sans-serif",
    tagline: "העוזרת החכמה של הבית והמשפחה",
    mockGroup: "משפחת כהן",
    mockMembers: "אמא, אבא, נועה, איתי, שלי",
    mockMessages: [
      { sender: "אמא", text: "חלב, לחם וביצים", type: "user" },
      { sender: "שלי", text: "\u{1F6D2} הוספתי חלב, לחם וביצים לרשימה", type: "bot" },
      { sender: "אבא", text: "@שלי תזכירי לי לעצור בסופר בדרך הביתה", type: "user", mention: "@שלי" },
      { sender: "שלי", text: "\u{1F514} בשמחה! אזכיר לך ב-18:00 לעצור בסופר", type: "bot" },
      { sender: "שלי", text: "\u{1F381} זוכרים שיש יומולדת לסבתא ביום שישי? זמן טוב לקנות מתנה", type: "bot" },
    ],
    cta: "הוסיפו את שלי לקבוצה",
    freeBadge: "חינם לגמרי · עד 30 פעולות בחודש · בלי כרטיס אשראי",
    qrLabel: "או סרקו את הקוד",
    signin: "יש לי כבר חשבון \u2190 כניסה",
    featuresTitle: "מה שלי יודעת לעשות?",
    features: [
      { Icon: ShoppingFeatureIcon, title: "רשימת קניות", subtitle: 'אמרו "חלב" בקבוצה וזה ברשימה. בלי אפליקציה, בלי הקלדה' },
      { Icon: CalendarFeatureIcon, title: "חוגים, הסעות ואירועים", subtitle: "שלי מזהה תאריכים ומארגנת את היומן המשפחתי" },
      { Icon: ChoresFeatureIcon, title: "מטלות בית", subtitle: "מי עושה מה ומתי, שלי זוכרת ומעדכנת" },
    ],
    stepsTitle: "איך זה עובד?",
    steps: [
      { title: "הוסיפו את שלי לקבוצת הווטסאפ", subtitle: "לחצו על הכפתור ושלי מצטרפת לקבוצה שלכם" },
      { title: "דברו כרגיל", subtitle: "שלי מבינה עברית טבעית: קניות, מטלות, אירועים" },
      { title: "הכל מסתדר", subtitle: "הרשימה, היומן והמטלות מתעדכנים אוטומטית" },
    ],
    faqTitle: "שאלות נפוצות",
    faq: [
      { q: "איך שלי עובדת?", a: "שלי היא מנוע בינה מלאכותית חכם שמבין עברית בשיחה טבעית — תגידו \u0022חלב\u0022 והיא תוסיף לרשימה, תכתבו \u0022לאסוף את נועה מהחוג ב-5\u0022 והיא תזכיר לכם בזמן, ואפילו תחלק מטלות בית בין בני הבית. היא לומדת את הסגנון שלכם עם הזמן — כינויים, מוצרים קבועים, שעות שחוזרות. ככל שתשתמשו יותר, היא תבין אתכם טוב יותר." },
      { q: "יש גם אפליקציה?", a: "כן! לשלי יש אפליקציה נהדרת - רשימת הקניות, המטלות ולוח האירועים מתעדכנים בזמן אמת, גם מהווטסאפ וגם מהאפליקציה. אפשר לצפות בהכל, לערוך ולהתעדכן בקלות. היכנסו: sheli.ai" },
      { q: "כמה זה עולה?", a: "חינם לגמרי עד 30 פעולות בחודש, כל חודש!\nצריכים יותר פעולות? הצטרפו למנוי פרימיום ללא הגבלה ב-9.90 \u20AA לחודש בלבד." },
      { q: "מה עם הפרטיות?", a: "שלי לא שומרת תמונות או וידאו. היא יכולה לשמוע הודעות קוליות קצרות - תוכלו להקליט לה את המצרכים לקניות או את מטלות הבית בדיוק כמו בהודעת טקסט - היא לא שומרת את ההקלטה אלא רק את התוכן שלה, בדיוק כמו הודעה רגילה. כל המידע נמחק אחרי 30 יום. שיחות אישיות? שלי לא רואה אותן בכלל. רק בני הבית שלכם רואים את המידע - אף אחד אחר לא יכול לגשת למידע, כולל אותנו." },
      { q: "איך מתחילים? ואיך מפסיקים?", a: "הוסיפו את שלי לכל קבוצת ווטסאפ קיימת — היא מתחילה לעזור מיד. רוצים להפסיק? פשוט הוציאו אותה מהקבוצה. הכל נמחק אוטומטית, בלי התחייבות." },
    ],
    bottomTitle: "מוכנים להתחיל?",
    bottomLink: "קחו אותי לאפליקציה",
    bottomOr: "או",
    langToggle: "EN",
  },
  en: {
    dir: "ltr",
    font: "'Nunito', sans-serif",
    tagline: "Your home & family's smart helper",
    mockGroup: "The Johnsons",
    mockMembers: "Mom, Dad, Emma, Jake, Sheli",
    mockMessages: [
      { sender: "Mom", text: "Milk, bread and eggs", type: "user" },
      { sender: "Sheli", text: "\u{1F6D2} Added milk, bread and eggs to the list", type: "bot" },
      { sender: "Dad", text: "@Sheli remind me to stop at the store on the way home", type: "user", mention: "@Sheli" },
      { sender: "Sheli", text: "\u{1F514} Sure! I'll remind you at 6pm to stop at the store", type: "bot" },
      { sender: "Sheli", text: "\u{1F381} Remember Grandma's birthday is on Friday? Good time to get a gift", type: "bot" },
    ],
    cta: "Add Sheli to your group",
    freeBadge: "Completely free · Up to 30 actions/month · No credit card",
    qrLabel: "or scan the code",
    signin: "I have an account \u2192 Sign in",
    featuresTitle: "What can Sheli do?",
    features: [
      { Icon: ShoppingFeatureIcon, title: "Shopping lists", subtitle: 'Say "milk" in the group and it\'s on the list. No app, no typing.' },
      { Icon: CalendarFeatureIcon, title: "Events & scheduling", subtitle: "Sheli spots dates and organizes the family calendar" },
      { Icon: ChoresFeatureIcon, title: "Household tasks", subtitle: "Who does what and when — Sheli remembers and updates" },
    ],
    stepsTitle: "How does it work?",
    steps: [
      { title: "Add Sheli to your WhatsApp group", subtitle: "Tap the button and Sheli joins your group" },
      { title: "Just talk normally", subtitle: "Sheli understands natural language: shopping, tasks, events" },
      { title: "Everything stays organized", subtitle: "Lists, calendar and tasks update automatically" },
    ],
    faqTitle: "FAQ",
    faq: [
      { q: "How does Sheli work?", a: "Sheli is a smart AI that understands natural language — say \"milk\" and it's on the list, write \"pick up Emma from class at 5\" and she'll remind you on time, even assign chores around the house. She learns your style over time — nicknames, regular products, recurring schedules. The more you use her, the better she gets." },
      { q: "Is there also an app?", a: "Yes! Sheli has an amazing app — your shopping list, tasks and calendar sync in real time, both from WhatsApp and the app. View, edit and stay up to date easily. Visit: sheli.ai" },
      { q: "How much does it cost?", a: "30 actions per month for free, no credit card needed. Want unlimited? Premium is $2.70/month." },
      { q: "What about privacy?", a: "Sheli doesn't store photos or videos. She can listen to short voice messages — you can record your shopping list or household tasks just like a text message. She doesn't save the recording, only its content, just like a regular message. All data is deleted after 30 days. Personal conversations? Sheli doesn't see them at all. Only your household members can see your data — nobody else, including us." },
      { q: "How do I start? And stop?", a: "Add Sheli to any existing WhatsApp group — she starts helping right away. Want to stop? Just remove her from the group. Everything is deleted automatically, no strings attached." },
    ],
    bottomTitle: "Ready to get started?",
    bottomLink: "Take me to the app",
    bottomOr: "or",
    langToggle: "עב",
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

        {/* WhatsApp Mock */}
        <div className="wa-mock">
          <div className="wa-mock-header">
            <div className="wa-mock-avatar">👨‍👩‍👧</div>
            <div className="wa-mock-group-info">
              <span className="wa-mock-group-name">{c.mockGroup}</span>
              <span className="wa-mock-group-members">{c.mockMembers}</span>
            </div>
          </div>
          <div className="wa-mock-chat" style={{ direction: lang === "he" ? "rtl" : "ltr" }}>
            {c.mockMessages.map((msg, i) => (
              <div
                key={i}
                className={`wa-bubble wa-bubble-${msg.type}`}
                style={{ animationDelay: `${i * 0.15}s` }}
              >
                <span className={`wa-bubble-sender wa-bubble-sender-${msg.type}`}>
                  {msg.sender}
                </span>
                {msg.mention
                  ? <>{msg.text.split(msg.mention)[0]}<span className="wa-mention">{msg.mention}</span>{msg.text.split(msg.mention)[1]}</>
                  : msg.text}
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
          <img src="/qr-whatsapp.svg" alt="QR code to add Sheli on WhatsApp" width="140" height="140" />
          <span className="landing-qr-label">{c.qrLabel}</span>
        </a>

        <button className="landing-signin" onClick={handleSignIn}>
          {c.signin}
        </button>
      </section>

      {/* ─── Features ─── */}
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
