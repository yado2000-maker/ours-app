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
    effective: "בתוקף מיום 7 במאי 2026",
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
        p: "אנחנו משתמשים במידע שאתם שולחים אך ורק כדי לספק את הפיצ'רים של שלי שאתם רואים בפועל ולשפר אותם — רשימות קניות, מטלות, תזכורות, יומן, הוצאות, ותשובות בשיחה. אנחנו לא משתמשים בהודעות שלכם או בתוכן שלכם כדי לאמן מודלי AI/ML כלליים. סטטיסטיקות שימוש מצטברות ואנונימיות לחלוטין — מספרים, זמני תגובה, שיעורי שגיאה, אף פעם לא תוכן הודעה — עוזרות לנו לעקוב אחרי יציבות ולתכנן גידול.",
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
        h: "נתוני משתמש מ-Google (כניסה דרך Google ויומן Google)",
        p: "כשאתם נכנסים דרך Google, אנחנו מקבלים את שמכם, כתובת האימייל, תמונת הפרופיל ומזהה החשבון שלכם ב-Google (טענת ה-`sub` ב-OAuth). אם תאשרו את ההרשאה `https://www.googleapis.com/auth/calendar.events`, שלי תוכל גם לקרוא אירועים קרובים מהיומן הראשי שלכם וליצור או לעדכן אירועים שתבקשו ממנה במפורש לתזמן.\n\nעם מי משותפים, מועברים או נחשפים נתוני משתמש מ-Google:\n• Anthropic, PBC (Claude API): כשאתם שואלים את שלי שאלה הקשורה ליומן (\"מה יש לי מחר?\", \"תעבירי את התור לרופא ליום חמישי\"), הכותרות, המועדים והתיאורים של האירועים הרלוונטיים נשלחים בזמן אמת לממשק ה-API של Claude לצורך יצירת התשובה של שלי או ביצוע עדכון היומן שביקשתם. Anthropic מעבדת את הבקשה בהתאם לתנאי ה-API המסחריים שלה; הקלט לא משמש לאימון המודלים של Anthropic, ונשמר אצלם עד 30 יום לצורכי ניטור שימוש לרעה תחת מגבלות חוזיות.\n• Supabase Inc. (בסיס הנתונים הענני המנוהל שלנו, אזור האיחוד האירופי — פרנקפורט): שומר את פרופיל ה-Google שלכם (שם, אימייל, מזהה חשבון) ומטמון של הפניות לאירועים (מזהה אירוע, כותרת, מועד התחלה וסיום) כדי שתזכורות שלי יידעו לאיזה אירוע ביומן הן קשורות. הצפנה במצב מנוחה.\n\nאנחנו לא משתפים, מוכרים או מעבירים נתוני משתמש מ-Google לאף גורם אחר. אנחנו לא מעבירים אותם לפלטפורמות פרסום, סוחרי מידע, מתווכי מידע או לכל ספק AI צד שלישי מלבד Anthropic כפי שתואר לעיל. אנחנו לא משתמשים בנתוני משתמש מ-Google כדי לאמן מודלי AI/ML כלליים, להגיש פרסומות, או לכל מטרה אחרת מלבד הפיצ'רים שאתם רואים במוצר.\n\nהשימוש וההעברה של מידע שמתקבל מממשקי Google APIs לכל אפליקציה אחרת יעמדו במדיניות Google API Services User Data Policy, כולל דרישות ה-Limited Use.\n\nאנשי הצוות שלנו לא ניגשים לנתוני משתמש מ-Google אלא (א) בהסכמה מפורשת ובכתב מצידכם, (ב) לחקירת אירוע אבטחה או שימוש לרעה ספציפי, או (ג) כשהחוק מחייב זאת.\n\nניתן לבטל בכל רגע את הגישה של שלי ל-Google דרך https://myaccount.google.com/permissions או על ידי מחיקת חשבון Sheli שלכם. אנחנו מוחקים נתוני משתמש מ-Google שנשמרו במטמון תוך 30 יום מביטול הגישה או מחיקת החשבון.",
      },
      {
        h: "איפה המידע נשמר וכמה זמן",
        p: "הנתונים נשמרים בתשתית ענן מאובטחת באיחוד האירופי. ישראל מוכרת על ידי האיחוד האירופי כמדינה עם רמת הגנה נאותה על מידע אישי, ולהיפך. היסטוריית הודעות פעילה נשמרת עד 30 יום, ולאחר מכן נמחקת אוטומטית (למעט נתונים תפעוליים כמו רשימות ואירועים שאתם בחרתם לשמור). אנחנו לא מוכרים מידע לאף גורם.",
      },
      {
        h: "ספקי שירות מרכזיים",
        p: "כדי להפעיל את השירות אנחנו נעזרים בספקי צד שלישי אמינים: Anthropic, PBC (מודל Claude — לסיווג כוונה, יצירת תשובות, עיבוד תמונות, ולהבנת בקשות יומן Google); Hugging Face Inc. (תמלול הודעות קוליות קצרות, מופעל על נקודת קצה ייעודית פרטית); Groq Inc. (תמלול הודעות קוליות במצב גיבוי, כשהספק הראשי לא זמין); Google LLC (כניסה דרך Google, ולמשתמשים שמחברים — Google Calendar API); Supabase Inc. (בסיס נתונים מנוהל באיחוד האירופי); Meta Platforms / WhatsApp (הערוץ שבו שלי מדברת איתכם); ו-iCount (חיוב וחשבוניות למנויים בתשלום). כל ספק מקבל רק את המינימום הנדרש כדי לבצע את תפקידו, ומחויב בחוזה לסטנדרטים של אבטחת מידע.",
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
    effective: "Effective May 7, 2026",
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
        p: "We use the data you send only to provide and improve the user-facing features in Sheli — shopping lists, tasks, reminders, calendar, expenses, and conversational replies. We do not use your messages or content to train generalized AI/ML models. Aggregate, fully de-identified usage statistics — counts, latency, error rates, never message content — help us monitor reliability and plan capacity.",
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
        h: "Google User Data (Google Sign-In and Google Calendar)",
        p: "When you sign in with Google, we receive your name, email address, profile picture, and Google account identifier (the OAuth `sub` claim). If you grant the `https://www.googleapis.com/auth/calendar.events` scope, Sheli can also read upcoming events from your primary calendar and create or update events you explicitly ask her to schedule.\n\nWith whom Google user data is shared, transferred, or disclosed:\n• Anthropic, PBC (Claude API): when you ask Sheli something that involves your calendar (e.g. \"what's on my schedule tomorrow?\", or \"move my dentist appointment to Thursday\"), the relevant event titles, times, and descriptions are sent transiently to Anthropic's Claude API for the sole purpose of generating Sheli's reply or carrying out the calendar update you requested. Anthropic processes the request under their commercial API terms; inputs are not used to train Anthropic's models, and Anthropic retains API requests for up to 30 days for abuse monitoring under contractual restrictions.\n• Supabase Inc. (our managed Postgres database, EU region — Frankfurt): stores your Google profile (name, email, account ID) and a cache of event references (event ID, title, start/end time) so Sheli can match your reminders to the right calendar event. Encrypted at rest.\n\nWe do not share, sell, or transfer Google user data to any other party. We do not transfer it to advertising platforms, data brokers, information resellers, or any third-party AI provider other than Anthropic as described above. We do not use Google user data to train generalized AI/ML models, to serve advertising, or for any purpose other than the user-facing features described in this policy.\n\nSheli's use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.\n\nHumans on our team do not access Google user data except (a) with your explicit written consent, (b) to investigate a specific security or abuse incident, or (c) where required by law.\n\nYou can revoke Sheli's Google access at any time from https://myaccount.google.com/permissions or by deleting your Sheli account. We delete cached Google user data within 30 days of revocation or account deletion.",
      },
      {
        h: "Where data is stored and for how long",
        p: "Data is stored on secure cloud infrastructure in the EU. Israel is recognized by the EU as providing an adequate level of data protection, and vice versa. Active message history is retained for up to 30 days and then automatically deleted (except operational data like lists and events you chose to keep). We don't sell your data to anyone.",
      },
      {
        h: "Key service providers",
        p: "To run the service we rely on trusted third-party providers: Anthropic, PBC (Claude API — for intent classification, reply generation, image content extraction, and reasoning over Google Calendar requests); Hugging Face Inc. (short voice-message transcription, served from a dedicated private inference endpoint); Groq Inc. (voice-message transcription as a fallback when our primary endpoint is unavailable); Google LLC (Google Sign-In and, for users who connect it, the Google Calendar API); Supabase Inc. (managed Postgres database in the EU region); Meta Platforms / WhatsApp (the channel Sheli talks to you on); and iCount (billing and invoicing for paid subscriptions). Each provider receives only the minimum data needed for its role and is contractually bound to data-security standards.",
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
            {s.p.split("\n\n").map((para, j) => (
              <p
                key={j}
                style={{
                  fontSize: 15,
                  lineHeight: 1.7,
                  color: "#1E2D2D",
                  marginBottom: 12,
                  whiteSpace: "pre-line",
                }}
              >
                {para}
              </p>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
