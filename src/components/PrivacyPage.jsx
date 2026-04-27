import { useState } from "react";
import "../styles/landing.css";

// TODO: confirm legal entity name, ח.פ./ע.פ./עוסק number, and registered address before public launch — currently reads "שלי AI" / "Sheli AI" as working brand identity.

const CONTENT = {
  he: {
    dir: "rtl",
    font: "'Heebo', sans-serif",
    langToggle: "EN",
    back: "חזרה ל-sheli.ai",
    title: "מדיניות פרטיות",
    effective: "בתוקף מיום 24 באפריל 2026",
    intro:
      "שלי (Sheli) היא עוזרת משפחתית בווטסאפ שעוזרת לכם לנהל קניות, מטלות, תזכורות, אירועים והוצאות. הפרטיות שלכם חשובה לנו — הנה מה שחשוב שתדעו.",
    sections: [
      {
        h: "מי אנחנו",
        p: "השירות מופעל על ידי שלי AI (להלן: \"שלי\" או \"אנחנו\"). אנחנו הבעלים והאחראים על המידע שאתם משתפים איתנו. פרטי קשר מלאים מופיעים בסוף המסמך.",
      },
      {
        h: "מה אנחנו אוספים",
        p: "שם, כתובת אימייל ומספר טלפון שאתם משתפים בהרשמה (אימייל דרך הרשמה רגילה או Google); הודעות ששולחים אל שלי (טקסט, קול או תמונה); ופרטי הבית שלכם (מי חבר, מה ברשימה, אירועים, הוצאות). אם אתם מצרפים את שלי לקבוצת משפחה בווטסאפ, אנחנו שומרים גם את מזהה הקבוצה, שמה, ומספרי הטלפון של חברי הקבוצה — כדי ששלי תוכל להגיב לכולם. למנויים בתשלום אנחנו שומרים את סטטוס המנוי ומספר החשבונית (פרטי כרטיס האשראי עצמו מעובדים על ידי iCount ולא נשמרים אצלנו). כמו כל שירות אינטרנט, שרתי השירות רושמים באופן אוטומטי גם נתונים טכניים בסיסיים — כתובת IP ומזהה דפדפן או התקן — לצורך אבטחה ותפעול. אנחנו לא אוספים אנשי קשר, מיקום מדויק, או תוכן של שיחות אחרות שלכם בווטסאפ.",
      },
      {
        h: "על בסיס מה אנחנו מעבדים",
        p: "אנחנו מעבדים את המידע שלכם על בסיס ההסכמה שנתתם בהרשמה והצורך לספק לכם את השירות (ביצוע חוזה). אתם יכולים לבטל את ההסכמה בכל רגע על ידי מחיקת החשבון.",
      },
      {
        h: "איך אנחנו משתמשים בזה",
        p: "המידע שאתם שולחים מועבר אל שלי כדי שהיא תבין אתכם ותגיב — תוסיף לרשימת קניות, תיצור תזכורת, תענה על שאלה. אנחנו גם משתמשים בחלק מהנתונים (בצורה מצומצמת ואנונימית) כדי לשפר את הדיוק של שלי בעברית.",
      },
      {
        h: "מי רואה את המידע שלכם",
        p: "הודעות בקבוצת משפחה נראות לכל חברי הבית. הודעות פרטיות ב-1:1 עם שלי נשארות פרטיות. הוצאות שתירשמו בשיחה פרטית מסומנות כפרטיות כברירת מחדל.",
      },
      {
        h: "זיכרונות משפחתיים",
        p: "שלי שומרת פרטים קטנים שעוזרים לה להיות רלוונטית — למשל \"נועה אלרגית לאגוזים\", \"יום ההולדת של דן ב-3 במאי\", או כינויים משפחתיים. חלק מהזיכרונות נשמרים אוטומטית מתוך השיחה, וחלק נוצרים כשאתם אומרים לה במפורש לזכור. אתם יכולים לבקש ממנה בכל רגע לשכוח פרט מסוים או לראות את כל מה שהיא זוכרת עליכם. הזיכרונות המשפחתיים מוגנים ברמת אבטחה מקסימלית, כמו שאר המידע שלכם, ואיש לא יכול לראות אותם.",
      },
      {
        h: "עיבוד AI",
        p: "כדי להבין את ההודעות שלכם, שלי משתמשת במודלים של בינה מלאכותית שמסווגים את הכוונה (למשל: קנייה, תזכורת, שאלה) ומייצרים תשובה. הכוונה מתורגמת לפעולה בחשבון שלכם — ותמיד ניתן לבטל או לתקן בהודעה חוזרת. לצורך העיבוד, הודעות נשלחות לספקי ה-AI (ראו \"ספקי שירות מרכזיים\" למטה) שפועלים בארה\"ב. ההודעות לא משמשות לאימון מודלים של צד שלישי. הודעות קוליות מתומללות לטקסט ונמחקות מיד לאחר התמלול. תמונות שתשלחו (למשל קבלה או מסמך) מעובדות כדי לחלץ את התוכן הרלוונטי (למשל סכום, תאריך, פריטים), ונמחקות לאחר העיבוד — אנחנו לא שומרים את קובץ התמונה עצמו.",
      },
      {
        h: "איפה המידע נשמר וכמה זמן",
        p: "הנתונים נשמרים בתשתית ענן מאובטחת באיחוד האירופי. ישראל מוכרת על ידי האיחוד האירופי כמדינה עם רמת הגנה נאותה על מידע אישי, ולהיפך. היסטוריית הודעות פעילה נשמרת עד 30 יום, ולאחר מכן נמחקת אוטומטית (למעט נתונים תפעוליים כמו רשימות ואירועים שאתם בחרתם לשמור). אנחנו לא מוכרים מידע לאף גורם.",
      },
      {
        h: "ספקי שירות מרכזיים",
        p: "כדי להפעיל את השירות אנחנו נעזרים בספקי צד שלישי אמינים: Anthropic (מודל Claude, לסיווג כוונה, יצירת תשובות ועיבוד תמונות), Groq (תמלול הודעות קוליות), Meta / WhatsApp (הערוץ שבו שלי מדברת איתכם), ו-iCount (חיוב וחשבוניות למנויים בתשלום). כל ספק מקבל רק את המינימום הנדרש כדי לבצע את תפקידו, ומחויב בחוזה לסטנדרטים של אבטחת מידע.",
      },
      {
        h: "עוגיות ואנליטיקה",
        p: "באתר sheli.ai אנחנו משתמשים בכלי אנליטיקה שמכבדים פרטיות כדי להבין איך משתמשים בשירות ולשפר אותו. הכלים משתמשים באחסון מקומי בדפדפן (localStorage) ובעוגיות בסיסיות. אפשר לחסום אותם בהגדרות הדפדפן או באמצעות חוסמי פרסומות — זה לא פוגע בפונקציונליות. בתוך הצ'אט עם שלי בווטסאפ אין עוגיות או טרקרים.",
      },
      {
        h: "אבטחה ודיווח על אירועים",
        p: "אנחנו משתמשים בהצפנה בתעבורה (HTTPS/TLS), בהרשאות גישה מוגבלות, ובסיסמאות מוצפנות. אם יתרחש אירוע אבטחה שמסכן את המידע שלכם באופן ממשי — נדווח על כך לרשות להגנת הפרטיות ולכם ללא דיחוי, בהתאם לתקנות הגנת הפרטיות (אבטחת מידע) התשע\"ז-2017.",
      },
      {
        h: "הזכויות שלכם",
        p: "אתם יכולים: לראות איזה מידע יש עלינו (זכות עיון), לתקן מידע שגוי (זכות תיקון), למחוק את החשבון וכל הנתונים של הבית (זכות מחיקה), לבטל את ההסכמה לעיבוד בכל רגע, או להתנגד לעיבוד מסוים. פשוט שלחו לנו מייל.",
      },
      {
        h: "ילדים",
        p: "השירות לא מיועד לילדים מתחת לגיל 13, ואנחנו לא אוספים מידע ביודעין מילדים בגיל הזה. אם גילינו שנאסף מידע כזה — נמחק אותו. ילדים מעל גיל 13 שמצטרפים לקבוצת המשפחה עושים זאת באחריות ההורים, שנותנים הסכמה בשמם.",
      },
      {
        h: "שינויים",
        p: "אם נעדכן את המדיניות, נודיע כאן ונרענן את התאריך למעלה. שינויים מהותיים יפורסמו גם באמצעות הודעה משלי או במייל. שימוש מתמשך בשלי אחרי עדכון נחשב הסכמה למדיניות המעודכנת.",
      },
      {
        h: "יצירת קשר",
        p: "לשאלות ובקשות כלליות: service@sheli.family. לפניות בנושא פרטיות (עיון, תיקון, מחיקה, ביטול הסכמה): privacy@sheli.family. אנחנו נחזור אליכם תוך פרק זמן סביר.",
      },
    ],
  },
  en: {
    dir: "ltr",
    font: "'Nunito', sans-serif",
    langToggle: "עב",
    back: "Back to sheli.ai",
    title: "Privacy Policy",
    effective: "Effective April 24, 2026",
    intro:
      "Sheli is a family assistant on WhatsApp that helps you manage shopping, tasks, reminders, events and expenses. Your privacy matters to us — here's what you should know.",
    sections: [
      {
        h: "Who we are",
        p: "The service is operated by Sheli AI (\"Sheli\" or \"we\"). We own and are responsible for the information you share with us. Full contact details are at the end of this document.",
      },
      {
        h: "What we collect",
        p: "Your name, email and phone number when you sign up (email via standard signup or Google); messages you send to Sheli (text, voice or image); and your household details (members, list items, events, expenses). If you add Sheli to a family WhatsApp group, we also store the group ID, its name, and the phone numbers of group members — so Sheli can respond to everyone. For paid subscribers, we keep subscription status and invoice numbers (the credit card details themselves are processed by iCount and not stored by us). Like any web service, our servers also automatically log basic technical data — IP address and a browser/device identifier — for security and operations. We don't collect your contacts, precise location, or the content of other WhatsApp chats.",
      },
      {
        h: "Legal basis for processing",
        p: "We process your data based on the consent you gave at signup and on the necessity of providing the service you requested (contractual necessity). You can withdraw consent anytime by deleting your account.",
      },
      {
        h: "How we use it",
        p: "So Sheli can understand you and respond — add to your shopping list, set a reminder, answer a question. We also use limited, anonymized data to improve Sheli's accuracy in Hebrew.",
      },
      {
        h: "Who sees your data",
        p: "Messages in a family group are visible to all household members. Private 1:1 messages with Sheli stay private. Expenses logged in a private chat default to private visibility.",
      },
      {
        h: "Family memories",
        p: "Sheli keeps little details that help her stay relevant — e.g. \"Noa is allergic to nuts\", \"Dan's birthday is May 3\", or family nicknames. Some memories are captured automatically from conversation; others are created when you explicitly ask her to remember. You can ask her at any time to forget a specific detail or to show everything she remembers about you. Family memories are protected at the highest security level, like the rest of your data, and no one else can see them.",
      },
      {
        h: "AI processing",
        p: "To understand your messages, Sheli uses AI models that classify intent (e.g. shopping, reminder, question) and generate a reply. That intent is turned into an action in your account — you can always undo or correct it with a follow-up message. For this processing, messages are sent to our AI providers (see \"Key service providers\" below), which operate in the US. Your messages are not used to train third-party models. Voice messages are transcribed to text and deleted immediately after transcription. Images you send (e.g. a receipt or document) are processed to extract the relevant content (amount, date, items) and then deleted — we don't keep the image file itself.",
      },
      {
        h: "Where data is stored and for how long",
        p: "Data is stored on secure cloud infrastructure in the EU. Israel is recognized by the EU as providing an adequate level of data protection, and vice versa. Active message history is retained for up to 30 days and then automatically deleted (except operational data like lists and events you chose to keep). We don't sell your data to anyone.",
      },
      {
        h: "Key service providers",
        p: "To run the service we rely on trusted third-party providers: Anthropic (Claude model, for intent classification, reply generation and image processing), Groq (voice message transcription), Meta / WhatsApp (the channel Sheli talks to you on), and iCount (billing and invoicing for paid subscriptions). Each provider receives only the minimum data needed for its role and is contractually bound to data-security standards.",
      },
      {
        h: "Cookies and analytics",
        p: "On sheli.ai we use privacy-respecting analytics tools to understand how the service is used and to improve it. These tools use browser local storage and basic cookies. You can block them in your browser settings or with an ad blocker — it won't affect functionality. There are no cookies or trackers inside your WhatsApp chat with Sheli.",
      },
      {
        h: "Security and breach notification",
        p: "We use transport encryption (HTTPS/TLS), restricted access controls, and hashed passwords. If a security incident materially endangers your data, we'll notify the Privacy Protection Authority and you without undue delay, in accordance with the 2017 Israeli Data Security Regulations.",
      },
      {
        h: "Your rights",
        p: "You can: see what data we hold (right of access), correct inaccurate data (right of rectification), delete the account and all household data (right to erasure), withdraw consent to processing at any time, or object to specific processing. Just email us.",
      },
      {
        h: "Children",
        p: "The service is not intended for children under 13, and we don't knowingly collect information from them. If we discover such information, we'll delete it. Children over 13 who join a family group do so under parental responsibility, with consent given on their behalf.",
      },
      {
        h: "Changes",
        p: "If we update this policy, we'll post it here and refresh the date above. Material changes will also be announced by email or by Sheli directly. Continued use of Sheli after an update means you accept the updated policy.",
      },
      {
        h: "Contact",
        p: "For general questions and requests: service@sheli.family. For privacy-specific matters (access, correction, deletion, withdrawal of consent): privacy@sheli.family. We'll get back to you within a reasonable time.",
      },
    ],
  },
};

export default function PrivacyPage() {
  const [lang, setLang] = useState("he");
  const c = CONTENT[lang];

  return (
    <div className="landing" dir={c.dir} style={{ fontFamily: c.font }}>
      <button
        type="button"
        className="landing-lang-toggle"
        onClick={() => setLang(lang === "he" ? "en" : "he")}
      >
        {c.langToggle}
      </button>

      <section
        style={{
          maxWidth: 680,
          margin: "0 auto",
          width: "100%",
          padding: "32px 20px calc(60px + env(safe-area-inset-bottom))",
        }}
      >
        <a
          href="/"
          style={{
            display: "inline-block",
            color: "#2D8E6F",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
            marginBottom: 24,
          }}
        >
          {lang === "he" ? "→ " : "← "}{c.back}
        </a>

        <h1
          className="landing-section-title"
          style={{ textAlign: lang === "he" ? "right" : "left", marginBottom: 8 }}
        >
          {c.title}
        </h1>
        <p style={{ color: "#888", fontSize: 14, marginBottom: 24 }}>{c.effective}</p>

        <p style={{ fontSize: 16, lineHeight: 1.7, marginBottom: 32 }}>{c.intro}</p>

        {c.sections.map((s, i) => (
          <div key={i} style={{ marginBottom: 28 }}>
            <h2
              style={{
                color: "#E8725C",
                fontSize: 18,
                fontWeight: 700,
                marginBottom: 8,
              }}
            >
              {s.h}
            </h2>
            <p style={{ fontSize: 15, lineHeight: 1.7, color: "#1E2D2D" }}>{s.p}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
