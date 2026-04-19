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
      "שלי קולטת מצטרפים חדשים בהדרגה כדי לתת שירות מעולה לכולם. השאירו פרטים ושלי תחזור אליכם ברגע שיגיע תורכם!",
    fieldFirstName: "שם פרטי",
    fieldLastName: "שם משפחה",
    fieldPhone: "טלפון",
    fieldPhoneHint: "גרים בחו״ל? הוסיפו + וקוד מדינה (+1 ארה״ב, +351 פורטוגל וכו׳)",
    fieldEmail: "אימייל",
    fieldInterest: "מה הכי מעניין אתכם?",
    interestOptions: [
      { value: "shopping", label: "רשימת קניות משותפת" },
      { value: "reminders", label: "תזכורות" },
      { value: "calendar", label: "יומן פגישות ולו\"ז" },
      { value: "other", label: "משהו אחר" },
    ],
    fieldOtherDetail: "במה שלי יכולה לעזור לכם?",
    consentLabel: "אני מסכימ/ה שתחזרו אליי בווטסאפ או במייל כשיגיע תורי",
    submit: "שמרו לי מקום",
    submitting: "רגע אחד...",
    success:
      "קלטתי אתכם 🧡\nאחזור אליכם ברגע שיגיע תורכם",
    errorInvalidPhone: "מספר טלפון לא תקין",
    errorInvalidEmail: "אימייל לא תקין",
    errorConsentRequired: "צריך לאשר שאפשר לחזור אליכם כדי להירשם",
    errorAlreadyIn: "המספר כבר רשום ברשימת ההמתנה 🧡",
    errorGeneric: "משהו השתבש. נסו שוב?",
    langToggle: "EN",
  },
  en: {
    dir: "ltr",
    title: "Sheli waitlist",
    subtitle:
      "Sheli is welcoming new signups in small batches to keep quality high. Leave your details and I'll reach out when it's your turn.",
    fieldFirstName: "First name",
    fieldLastName: "Last name",
    fieldPhone: "Phone number",
    fieldPhoneHint: "From abroad? Add + and country code (+1 US, +351 Portugal, etc.)",
    fieldEmail: "Email",
    fieldInterest: "What's most interesting to you?",
    interestOptions: [
      { value: "shopping", label: "Shared shopping list" },
      { value: "reminders", label: "Reminders" },
      { value: "calendar", label: "Calendar & appointments" },
      { value: "other", label: "Something else" },
    ],
    fieldOtherDetail: "What can Sheli help you with?",
    consentLabel: "I agree to be contacted on WhatsApp or email when it's my turn",
    submit: "Save my spot",
    submitting: "One moment...",
    success:
      "We've got you 🧡\nI'll get back to you when it's your turn",
    errorInvalidPhone: "Invalid phone number",
    errorInvalidEmail: "Invalid email address",
    errorConsentRequired: "Please confirm we can reach out before submitting",
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

function isValidEmail(email) {
  if (!email) return false; // required
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function WaitlistPage() {
  const [lang, setLang] = useState("he");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [interest, setInterest] = useState("");
  const [otherText, setOtherText] = useState("");
  const [consent, setConsent] = useState(false);
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
    if (!isValidEmail(email.trim())) {
      setErrorMsg(c.errorInvalidEmail);
      return;
    }
    if (!consent) {
      setErrorMsg(c.errorConsentRequired);
      return;
    }

    setStatus("submitting");

    const params = new URLSearchParams(window.location.search);
    const source = params.get("source") || "landing_cta";

    const { error } = await supabase.from("waitlist").insert({
      first_name: firstName.trim() || null,
      last_name: lastName.trim() || null,
      phone: normalizedPhone,
      email: email.trim() || null,
      interest: interest || null,
      notes: interest === "other" && otherText.trim() ? otherText.trim().slice(0, 500) : null,
      source,
      referrer_url: document.referrer || null,
      user_agent: navigator.userAgent.slice(0, 200),
      consent_given: true,
      consented_at: new Date().toISOString(),
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
      className="landing"
      dir={c.dir}
      style={{ fontFamily: lang === "he" ? "'Heebo', sans-serif" : "'Nunito', sans-serif" }}
    >
      <button
        type="button"
        className="landing-lang-toggle"
        onClick={() => setLang(lang === "he" ? "en" : "he")}
      >
        {c.langToggle}
      </button>

      <section className="landing-hero" style={{ maxWidth: 480, margin: "0 auto", width: "100%" }}>
        <h1 className="landing-wordmark">sheli</h1>
        <h2 className="landing-section-title" style={{ marginTop: 24 }}>
          {c.title}
        </h2>
        {status !== "done" && (
          <p
            className="landing-tagline"
            style={{ fontWeight: 400, fontSize: 16, lineHeight: 1.6, marginTop: 8 }}
          >
            {c.subtitle}
          </p>
        )}

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
              width: "100%",
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
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
                    width: "100%",
                    boxSizing: "border-box",
                    minWidth: 0,
                  }}
                />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{c.fieldLastName}</span>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  style={{
                    padding: "12px 14px",
                    fontSize: 16,
                    border: "1px solid #ddd",
                    borderRadius: 10,
                    fontFamily: "inherit",
                    width: "100%",
                    boxSizing: "border-box",
                    minWidth: 0,
                  }}
                />
              </label>
            </div>

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
                  width: "100%",
                  boxSizing: "border-box",
                  minWidth: 0,
                }}
              />
              <span style={{ fontSize: 12, color: "#888", lineHeight: 1.4 }}>
                {c.fieldPhoneHint}
              </span>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{c.fieldEmail}</span>
              <input
                type="email"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                style={{
                  padding: "12px 14px",
                  fontSize: 16,
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  fontFamily: "inherit",
                  direction: "ltr",
                  textAlign: lang === "he" ? "right" : "left",
                  width: "100%",
                  boxSizing: "border-box",
                  minWidth: 0,
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
                    fontSize: 14,
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
              {interest === "other" && (
                <input
                  type="text"
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  placeholder={c.fieldOtherDetail}
                  maxLength={500}
                  style={{
                    padding: "10px 12px",
                    fontSize: 14,
                    border: "1px solid #ddd",
                    borderRadius: 10,
                    fontFamily: "inherit",
                    width: "100%",
                    boxSizing: "border-box",
                    minWidth: 0,
                    marginTop: 4,
                  }}
                />
              )}
            </fieldset>

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1.4,
              }}
            >
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span>{c.consentLabel}</span>
            </label>

            {errorMsg && (
              <div style={{ color: "#c0392b", fontSize: 14 }}>{errorMsg}</div>
            )}

            <button
              type="submit"
              className="landing-cta"
              disabled={status === "submitting" || !consent}
              style={{
                marginTop: 8,
                opacity: !consent || status === "submitting" ? 0.5 : 1,
                cursor: !consent || status === "submitting" ? "not-allowed" : "pointer",
              }}
            >
              {status === "submitting" ? c.submitting : c.submit}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
