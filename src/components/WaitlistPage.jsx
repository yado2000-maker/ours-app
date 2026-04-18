import { useState } from "react";
import { supabase } from "../lib/supabase.js";
import "../styles/landing.css";

// Recovery-period waitlist capture. Users land here from:
//   - landing page CTA (during recovery)
//   - WhatsApp Business Away Message link (sheli.ai/waitlist)
// Stored in public.waitlist; drained manually when Cloud API migration completes.

const CONTENT = {
  he: {
    dir: "rtl",
    title: "רשימת המתנה לשלי",
    subtitle:
      "שלי מוסיפה משפחות בהדרגה כדי לתת שירות מעולה לכולם. השאירו פרטים ואחזור אליכם ברגע שיהיה תורכם.",
    fieldFirstName: "שם פרטי",
    fieldPhone: "מספר טלפון (וואטסאפ)",
    fieldInterest: "מה הכי מעניין אתכם?",
    interestOptions: [
      { value: "shopping", label: "רשימת קניות משותפת" },
      { value: "reminders", label: "תזכורות" },
      { value: "family", label: "תיאום משפחתי" },
      { value: "other", label: "משהו אחר" },
    ],
    submit: "שמרו לי מקום",
    submitting: "רגע אחד...",
    success:
      "נרשמתם! 🧡\nאחזור אליכם ברגע שיהיה תורכם. תודה על הסבלנות.",
    errorInvalidPhone: "מספר טלפון לא תקין",
    errorAlreadyIn: "המספר כבר רשום ברשימת ההמתנה 🧡",
    errorGeneric: "משהו השתבש. נסו שוב?",
    langToggle: "EN",
  },
  en: {
    dir: "ltr",
    title: "Sheli waitlist",
    subtitle:
      "Sheli is onboarding families in small batches to keep quality high. Leave your details and I'll reach out when it's your turn.",
    fieldFirstName: "First name",
    fieldPhone: "Phone number (WhatsApp)",
    fieldInterest: "What's most interesting to you?",
    interestOptions: [
      { value: "shopping", label: "Shared shopping list" },
      { value: "reminders", label: "Reminders" },
      { value: "family", label: "Family coordination" },
      { value: "other", label: "Something else" },
    ],
    submit: "Save my spot",
    submitting: "One moment...",
    success:
      "You're on the list! 🧡\nI'll reach out when it's your turn. Thanks for your patience.",
    errorInvalidPhone: "Invalid phone number",
    errorAlreadyIn: "This number is already on the waitlist 🧡",
    errorGeneric: "Something went wrong. Try again?",
    langToggle: "עב",
  },
};

function normalizePhone(raw) {
  return (raw || "").replace(/[^\d+]/g, "");
}

function isValidPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

export default function WaitlistPage() {
  const [lang, setLang] = useState("he");
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [interest, setInterest] = useState("");
  const [status, setStatus] = useState("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const c = CONTENT[lang];

  async function handleSubmit(e) {
    e.preventDefault();
    setErrorMsg("");

    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) {
      setErrorMsg(c.errorInvalidPhone);
      return;
    }

    setStatus("submitting");

    const params = new URLSearchParams(window.location.search);
    const source = params.get("source") || "landing_cta";

    const { error } = await supabase.from("waitlist").insert({
      first_name: firstName.trim() || null,
      phone: normalizedPhone,
      interest: interest || null,
      source,
      referrer_url: document.referrer || null,
      user_agent: navigator.userAgent.slice(0, 200),
    });

    if (error) {
      if (error.code === "23505") {
        setStatus("done");
        setErrorMsg(c.errorAlreadyIn);
        return;
      }
      console.error("[waitlist] insert error:", error);
      setErrorMsg(c.errorGeneric);
      setStatus("idle");
      return;
    }

    setStatus("done");
  }

  return (
    <div
      className="landing-page"
      dir={c.dir}
      style={{ fontFamily: lang === "he" ? "'Heebo', sans-serif" : "'Nunito', sans-serif" }}
    >
      <div className="landing-lang-toggle-wrap">
        <button
          type="button"
          className="landing-lang-toggle"
          onClick={() => setLang(lang === "he" ? "en" : "he")}
        >
          {c.langToggle}
        </button>
      </div>

      <section className="landing-hero" style={{ maxWidth: 480, margin: "0 auto" }}>
        <h1 className="sheli-wordmark">sheli</h1>
        <h2 className="landing-section-title" style={{ marginTop: 24 }}>
          {c.title}
        </h2>
        <p
          className="landing-tagline"
          style={{ fontWeight: 400, fontSize: 16, lineHeight: 1.6, marginTop: 8 }}
        >
          {c.subtitle}
        </p>

        {status === "done" ? (
          <div
            className="waitlist-success"
            style={{
              marginTop: 32,
              padding: 24,
              background: "var(--white, #FAFCFB)",
              borderRadius: 16,
              textAlign: "center",
              whiteSpace: "pre-line",
              fontSize: 18,
              lineHeight: 1.6,
            }}
          >
            {errorMsg || c.success}
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            style={{
              marginTop: 32,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{c.fieldFirstName}</span>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                style={{
                  padding: "12px 14px",
                  fontSize: 16,
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  fontFamily: "inherit",
                }}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{c.fieldPhone}</span>
              <input
                type="tel"
                inputMode="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="050-123-4567"
                style={{
                  padding: "12px 14px",
                  fontSize: 16,
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  fontFamily: "inherit",
                  direction: "ltr",
                  textAlign: lang === "he" ? "right" : "left",
                }}
              />
            </label>

            <fieldset
              style={{
                border: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <legend style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                {c.fieldInterest}
              </legend>
              {c.interestOptions.map((opt) => (
                <label
                  key={opt.value}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    cursor: "pointer",
                    padding: "8px 12px",
                    border: "1px solid #e5e5e5",
                    borderRadius: 10,
                    background: interest === opt.value ? "var(--coral-50, #FFF1ED)" : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="interest"
                    value={opt.value}
                    checked={interest === opt.value}
                    onChange={(e) => setInterest(e.target.value)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </fieldset>

            {errorMsg && (
              <div style={{ color: "#c0392b", fontSize: 14 }}>{errorMsg}</div>
            )}

            <button
              type="submit"
              className="landing-cta"
              disabled={status === "submitting"}
              style={{ marginTop: 8 }}
            >
              {status === "submitting" ? c.submitting : c.submit}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
