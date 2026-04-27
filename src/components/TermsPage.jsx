import { useState } from "react";
import "../styles/landing.css";

const CONTENT = {
  he: {
    dir: "rtl",
    font: "'Heebo', sans-serif",
    langToggle: "EN",
    back: "חזרה ל-sheli.ai",
    title: "תנאי שימוש",
    effective: "בתוקף מיום 24 באפריל 2026",
    intro:
      "ברוכים הבאים לשלי. אלה התנאים לשימוש בשירות — קצר, ברור, בלי משפטית מיותרת. השימוש בשלי מהווה הסכמה לתנאים.",
    sections: [
      {
        h: "מה שלי עושה",
        p: "שלי היא עוזרת משפחתית בווטסאפ לניהול רשימות קניות, מטלות, תזכורות, אירועים והוצאות — בשיחה פרטית או בקבוצת המשפחה.",
      },
      {
        h: "חשבון חינם ומנוי",
        p: "החשבון החינמי כולל 40 פעולות בחודש. מנוי פרימיום עולה 14.90 ש\"ח לחודש או 149 ש\"ח לשנה (חיסכון של כ-17%) וכולל שימוש ללא הגבלה. החיוב מבוצע דרך iCount. הסכומים כוללים מע\"מ.",
      },
      {
        h: "ביטול מנוי",
        p: "אפשר לבטל את המנוי בכל רגע. ביטול ייכנס לתוקף בסוף תקופת החיוב הנוכחית ולא נבצע חיוב נוסף. אין החזר יחסי על החודש שכבר שולם.",
      },
      {
        h: "שימוש הוגן",
        p: "השירות מיועד לשימוש אישי ומשפחתי. אסור להשתמש בשלי לשליחת ספאם, תוכן לא חוקי, הטרדה, פגיעה בפרטיות של אחרים, או כל שימוש שמפר את תנאי השימוש של ווטסאפ עצמו.",
      },
      {
        h: "שלי טועה לפעמים",
        p: "שלי היא שירות אוטומטי ועלולה לטעות — לתזמן תזכורת לזמן לא נכון, לפרש שגוי הודעה, או להחמיץ משהו. אל תסתמכו עליה לעניינים קריטיים (תרופות, פגישות רפואיות, מועדים משפטיים) בלי לוודא בעצמכם.",
      },
      {
        h: "סגירת חשבון",
        p: "אנחנו שומרים לעצמנו את הזכות להשעות או לסגור חשבון במקרה של שימוש לרעה או הפרת התנאים. במקרים כאלה ננסה קודם ליצור קשר ולהבין לפני סגירה.",
      },
      {
        h: "אחריות",
        p: "השירות ניתן \"כמות שהוא\". אנחנו עושים כמיטב יכולתנו שהוא יעבוד, אבל לא יכולים להבטיח שלא יהיו תקלות. אין לנו אחריות לנזקים עקיפים שנגרמו מהסתמכות על שלי.",
      },
      {
        h: "שינויים בתנאים",
        p: "אם נעדכן את התנאים, נודיע כאן ונרענן את התאריך למעלה. שינויים מהותיים יפורסמו גם באמצעות הודעה משלי או במייל.",
      },
      {
        h: "חוק ושיפוט",
        p: "השירות פועל לפי חוקי מדינת ישראל. כל סכסוך או תביעה יידונו בבתי המשפט המוסמכים בתל אביב.",
      },
      {
        h: "יצירת קשר",
        p: "שאלות על התנאים, בקשות לביטול או בירורים? שלחו מייל ל-service@sheli.family ונחזור אליכם.",
      },
    ],
  },
  en: {
    dir: "ltr",
    font: "'Nunito', sans-serif",
    langToggle: "עב",
    back: "Back to sheli.ai",
    title: "Terms of Service",
    effective: "Effective April 24, 2026",
    intro:
      "Welcome to Sheli. These are the terms for using the service — short, clear, no lawyer-speak. Using Sheli means you agree to these terms.",
    sections: [
      {
        h: "What Sheli does",
        p: "Sheli is a family assistant on WhatsApp for managing shopping lists, tasks, reminders, events and expenses — in a private chat or in your family group.",
      },
      {
        h: "Free plan and subscription",
        p: "The free plan includes 40 actions per month. Premium costs 14.90 ILS/month or 149 ILS/year (about 17% savings) with unlimited use. Billing is handled via iCount. Prices include VAT.",
      },
      {
        h: "Cancellation",
        p: "You can cancel anytime. Cancellation takes effect at the end of the current billing period and we won't charge again. No pro-rated refunds for the current month.",
      },
      {
        h: "Fair use",
        p: "The service is for personal and family use. Don't use Sheli for spam, illegal content, harassment, violating others' privacy, or anything that breaks WhatsApp's own terms.",
      },
      {
        h: "Sheli makes mistakes",
        p: "Sheli is an automated service and can make mistakes — wrong reminder time, misunderstood message, missed something. Don't rely on her for critical matters (medications, medical appointments, legal deadlines) without verifying yourself.",
      },
      {
        h: "Account termination",
        p: "We reserve the right to suspend or terminate accounts for abuse or breach of terms. We'll try to reach out first to understand before closing.",
      },
      {
        h: "Liability",
        p: "The service is provided \"as is\". We do our best to keep it working, but we can't guarantee no outages. We're not liable for indirect damages caused by relying on Sheli.",
      },
      {
        h: "Changes to terms",
        p: "If we update these terms, we'll post them here and refresh the date above. Material changes will also be announced by email or by Sheli directly.",
      },
      {
        h: "Governing law",
        p: "The service operates under the laws of Israel. Any disputes will be settled in the competent courts of Tel Aviv.",
      },
      {
        h: "Contact",
        p: "Questions about the terms, cancellation requests, or anything else? Email service@sheli.family and we'll get back to you.",
      },
    ],
  },
};

export default function TermsPage() {
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
