import { useState, useEffect, useRef } from "react";
import T from "../locales/index.js";
import { supabase } from "../lib/supabase.js";

export default function AuthScreen({ onBack, lang = "en" }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup" | "check-email" | "forgot" | "forgot-sent" | "reset-password" | "phone" | "phone-otp"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const pollRef = useRef(null);

  const t = T[lang] || T.en;
  const dir = t.dir;
  const isHe = lang === "he";
  const font = isHe ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";

  const redirectUrl = window.location.hostname === "localhost"
    ? window.location.origin : "https://sheli.ai";

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  // Auto-poll for email verification completion
  useEffect(() => {
    if (mode !== "check-email") {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        clearInterval(pollRef.current);
        // Session appeared — boot effect will navigate
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [mode]);

  // Detect password recovery URL (from reset email link)
  // H9 fix: Don't strip hash immediately — let Supabase process it first via onAuthStateChange
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("type=recovery")) return;

    // Listen for Supabase to confirm the recovery session, THEN clean URL
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setMode("reset-password");
        // Safe to clean URL now — Supabase has the session
        window.history.replaceState({}, "", window.location.pathname);
        subscription.unsubscribe();
      }
    });

    // Safety net: if Supabase doesn't fire within 3s, show reset form anyway
    const timeout = setTimeout(() => {
      setMode("reset-password");
      window.history.replaceState({}, "", window.location.pathname);
      subscription.unsubscribe();
    }, 3000);

    return () => { clearTimeout(timeout); subscription.unsubscribe(); };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "signup") {
        if (!displayName.trim()) {
          setError(isHe ? "נא להזין שם" : "Please enter your name");
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          setError(isHe ? "הסיסמאות לא תואמות" : "Passwords don't match");
          setLoading(false);
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: displayName.trim() }, emailRedirectTo: redirectUrl },
        });
        if (error) throw error;
        if (!data?.session) {
          if (data?.user && (!data.user.identities || data.user.identities.length === 0)) {
            setError(isHe ? "כבר יש חשבון עם האימייל הזה. נסו התחברות" : "Already registered. Try signing in");
            setMode("signin");
          } else {
            setMode("check-email");
          }
          setLoading(false);
          return;
        }
        return; // auto-confirmed, boot effect will navigate

      } else if (mode === "reset-password") {
        if (password !== confirmPassword) {
          setError(isHe ? "הסיסמאות לא תואמות" : "Passwords don't match");
          setLoading(false);
          return;
        }
        if (password.length < 6) {
          setError(isHe ? "הסיסמה חייבת להכיל לפחות 6 תווים" : "Password must be at least 6 characters");
          setLoading(false);
          return;
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setMode("signin");
        setError(isHe ? "✓ הסיסמה שונתה בהצלחה. התחברו" : "✓ Password updated. Sign in now");
        setLoading(false);
        return;

      } else {
        // Sign in
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return; // boot effect navigates
      }
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("Invalid login") || msg.includes("invalid_credentials")) {
        setError(isHe ? "אימייל או סיסמה לא נכונים" : "Wrong email or password");
      } else if (msg.includes("Email not confirmed")) {
        setMode("check-email");
      } else {
        setError(msg || (isHe ? "משהו השתבש" : "Something went wrong"));
      }
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError(isHe ? "נא להזין אימייל" : "Please enter your email");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl });
      if (error) throw error;
      setMode("forgot-sent");
    } catch (err) {
      setError(err.message || (isHe ? "משהו השתבש" : "Something went wrong"));
    }
    setLoading(false);
  };

  const handleResendEmail = async () => {
    if (resendCooldown > 0) return;
    try {
      await supabase.auth.resend({ type: "signup", email });
      setResendCooldown(60);
    } catch {}
  };

  const handleGoogle = async () => {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectUrl },
    });
    // M17 fix: show error if OAuth fails (e.g. popup blocked)
    if (error) setError(isHe ? "ההתחברות עם Google נכשלה. נסו שוב" : "Google sign-in failed. Please try again");
  };

  // ── Phone Auth ──
  const formatPhoneForAuth = (raw) => {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("972")) return "+" + digits;
    if (digits.startsWith("0")) return "+972" + digits.slice(1);
    return "+972" + digits;
  };

  const handlePhoneSend = async () => {
    setError(null);
    const formatted = formatPhoneForAuth(phone);
    if (formatted.length < 13) {
      setError(isHe ? "נא להזין מספר טלפון תקין" : "Please enter a valid phone number");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({ phone: formatted });
      if (error) throw error;
      setMode("phone-otp");
    } catch (err) {
      setError(err.message || (isHe ? "משהו השתבש" : "Something went wrong"));
    }
    setLoading(false);
  };

  const handlePhoneVerify = async () => {
    setError(null);
    setLoading(true);
    try {
      const formatted = formatPhoneForAuth(phone);
      const { error } = await supabase.auth.verifyOtp({ phone: formatted, token: otpCode, type: "sms" });
      if (error) throw error;
      // Boot effect will navigate
    } catch (err) {
      setError(err.message || (isHe ? "קוד לא נכון" : "Invalid code"));
      setLoading(false);
    }
  };

  const inputStyle = {
    padding: "13px 15px", borderRadius: 12, border: "1.5px solid var(--border)",
    background: "var(--white)", fontSize: 15, color: "var(--dark)", outline: "none", fontFamily: "inherit",
  };

  // ── "Check your email" screen ──
  if (mode === "check-email") {
    return (
      <div style={{
        minHeight: "100dvh", background: "var(--cream)", display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "40px 24px", fontFamily: font, textAlign: "center",
      }} dir={dir}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>📬</div>
        <div style={{
          fontFamily: isHe ? "'Heebo', sans-serif" : "'Cormorant Garamond', serif", fontWeight: isHe ? 500 : 300,
          fontSize: 28, letterSpacing: isHe ? 0 : "0.18em", color: "var(--dark)", marginBottom: 12,
        }}>
          {isHe ? "בדקו את האימייל" : "Check your email"}
        </div>
        <p style={{ fontSize: 15, color: "var(--warm)", lineHeight: 1.6, maxWidth: 300, marginBottom: 8 }}>
          {isHe ? "שלחתי לכם קישור אימות ל:" : "I sent a verification link to:"}
        </p>
        <p style={{ fontSize: 15, fontWeight: 600, color: "var(--dark)", marginBottom: 24, direction: "ltr" }}>
          {email}
        </p>
        <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5, maxWidth: 280, marginBottom: 32 }}>
          {isHe ? "לחצו על הקישור באימייל. אחרי האימות, חיזרו ללשונית הזו — שלי תזהה אתכם אוטומטית" : "Click the link in your email. After verifying, come back to this tab — Sheli will detect you automatically"}
        </p>
        <button onClick={() => { setMode("signin"); setError(null); }}
          style={{ padding: "12px 28px", borderRadius: 999, background: "var(--dark)", color: "var(--white)", border: "none", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", marginBottom: 12 }}>
          {isHe ? "← חזרה להתחברות" : "← Back to sign in"}
        </button>
        <button onClick={handleResendEmail} disabled={resendCooldown > 0}
          style={{ background: "none", border: "none", color: resendCooldown > 0 ? "var(--border)" : "var(--muted)", fontSize: 13, cursor: resendCooldown > 0 ? "default" : "pointer", fontFamily: "inherit", padding: 6 }}>
          {resendCooldown > 0
            ? (isHe ? `שליחה מחדש (${resendCooldown}s)` : `Resend (${resendCooldown}s)`)
            : (isHe ? "שלחו שוב" : "Resend email")}
        </button>
      </div>
    );
  }

  // ── "Reset link sent" screen ──
  if (mode === "forgot-sent") {
    return (
      <div style={{
        minHeight: "100dvh", background: "var(--cream)", display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "40px 24px", fontFamily: font, textAlign: "center",
      }} dir={dir}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>✉️</div>
        <div style={{
          fontFamily: isHe ? "'Heebo', sans-serif" : "'Cormorant Garamond', serif", fontWeight: isHe ? 500 : 300,
          fontSize: 28, letterSpacing: isHe ? 0 : "0.18em", color: "var(--dark)", marginBottom: 12,
        }}>
          {isHe ? "בדקו את האימייל" : "Check your email"}
        </div>
        <p style={{ fontSize: 15, color: "var(--warm)", lineHeight: 1.6, maxWidth: 300, marginBottom: 24 }}>
          {isHe ? "אם יש חשבון עם האימייל הזה, שלחתי קישור לאיפוס סיסמה" : "If there's an account with this email, I sent a password reset link"}
        </p>
        <button onClick={() => { setMode("signin"); setError(null); setPassword(""); setConfirmPassword(""); }}
          style={{ padding: "12px 28px", borderRadius: 999, background: "var(--dark)", color: "var(--white)", border: "none", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>
          {isHe ? "← חזרה להתחברות" : "← Back to sign in"}
        </button>
      </div>
    );
  }

  // ── "Reset password" screen (from email link) ──
  if (mode === "reset-password") {
    return (
      <div style={{
        minHeight: "100dvh", background: "var(--cream)", display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "40px 24px", fontFamily: font,
      }} dir={dir}>
        <div style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 36, letterSpacing: "0.04em",
          background: "linear-gradient(135deg, #E8725C, #D4507A)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.08))", marginBottom: 4 }}>sheli</div>
        <p style={{ fontSize: 15, color: "var(--warm)", fontWeight: 400, marginBottom: 36 }}>
          {isHe ? "בחרו סיסמה חדשה" : "Choose a new password"}
        </p>
        <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>
          <input type="password" placeholder={isHe ? "סיסמה חדשה" : "New password"} value={password}
            onChange={(e) => setPassword(e.target.value)} dir="ltr" required minLength={6}
            autoComplete="new-password" style={inputStyle} />
          <input type="password" placeholder={isHe ? "אימות סיסמה" : "Confirm password"} value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)} dir="ltr" required minLength={6}
            autoComplete="new-password" style={inputStyle} />
          {error && <p style={{ fontSize: 13, color: "var(--accent)", textAlign: "center", margin: 0 }}>{error}</p>}
          <button type="submit" disabled={loading}
            style={{ padding: 15, borderRadius: 14, background: "var(--dark)", color: "var(--white)", border: "none", cursor: loading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 500, fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
            {loading ? (isHe ? "רגע..." : "Loading...") : (isHe ? "עדכנו סיסמה" : "Update Password")}
          </button>
        </form>
      </div>
    );
  }

  // ── "Forgot password" screen ──
  if (mode === "forgot") {
    return (
      <div style={{
        minHeight: "100dvh", background: "var(--cream)", display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "40px 24px", fontFamily: font,
      }} dir={dir}>
        <div style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 36, letterSpacing: "0.04em",
          background: "linear-gradient(135deg, #E8725C, #D4507A)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.08))", marginBottom: 4 }}>sheli</div>
        <p style={{ fontSize: 15, color: "var(--warm)", fontWeight: 400, marginBottom: 36 }}>
          {isHe ? "איפוס סיסמה" : "Reset password"}
        </p>
        <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>
          <input type="email" placeholder={isHe ? "אימייל" : "Email"} value={email}
            onChange={(e) => setEmail(e.target.value)} dir="ltr" required autoComplete="email"
            style={inputStyle} />
          {error && <p style={{ fontSize: 13, color: "var(--accent)", textAlign: "center", margin: 0 }}>{error}</p>}
          <button onClick={handleForgotPassword} disabled={loading}
            style={{ padding: 15, borderRadius: 14, background: "var(--dark)", color: "var(--white)", border: "none", cursor: loading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 500, fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
            {loading ? (isHe ? "רגע..." : "Loading...") : (isHe ? "שלחו קישור איפוס" : "Send reset link")}
          </button>
          <button onClick={() => { setMode("signin"); setError(null); }}
            style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 8 }}>
            {isHe ? "→ חזרה להתחברות" : "← Back to sign in"}
          </button>
        </div>
      </div>
    );
  }

  // ── Phone: Enter number ──
  if (mode === "phone") {
    return (
      <div style={{
        minHeight: "100dvh", background: "var(--cream)", display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "40px 24px", fontFamily: font,
      }} dir={dir}>
        <div style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 36, letterSpacing: "0.04em",
          background: "linear-gradient(135deg, #E8725C, #D4507A)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.08))", marginBottom: 4 }}>sheli</div>
        <p style={{ fontSize: 15, color: "var(--warm)", fontWeight: 400, marginBottom: 36 }}>
          {isHe ? "כניסה עם מספר טלפון" : "Sign in with phone number"}
        </p>
        <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>
          <input type="tel" placeholder={isHe ? "מספר טלפון (05X...)" : "Phone number"} value={phone}
            onChange={(e) => setPhone(e.target.value)} dir="ltr" required
            autoComplete="tel" style={inputStyle} />
          {error && <p style={{ fontSize: 13, color: "var(--accent)", textAlign: "center", margin: 0 }}>{error}</p>}
          <button onClick={handlePhoneSend} disabled={loading}
            style={{ padding: 15, borderRadius: 14, background: "var(--dark)", color: "var(--white)", border: "none", cursor: loading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 500, fontFamily: "inherit", opacity: loading ? 0.5 : 1 }}>
            {loading ? (isHe ? "שולח..." : "Sending...") : (isHe ? "שלחו קוד" : "Send code")}
          </button>
          <button onClick={() => { setMode("signin"); setError(null); }}
            style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 8 }}>
            {isHe ? "→ חזרה להתחברות" : "← Back to sign in"}
          </button>
        </div>
      </div>
    );
  }

  // ── Phone: Enter OTP ──
  if (mode === "phone-otp") {
    return (
      <div style={{
        minHeight: "100dvh", background: "var(--cream)", display: "flex",
        flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "40px 24px", fontFamily: font, textAlign: "center",
      }} dir={dir}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>📱</div>
        <div style={{
          fontFamily: isHe ? "'Heebo', sans-serif" : "'Cormorant Garamond', serif", fontWeight: isHe ? 500 : 300,
          fontSize: 28, letterSpacing: isHe ? 0 : "0.18em", color: "var(--dark)", marginBottom: 12,
        }}>
          {isHe ? "הזינו את הקוד" : "Enter the code"}
        </div>
        <p style={{ fontSize: 15, color: "var(--warm)", lineHeight: 1.6, maxWidth: 300, marginBottom: 24 }}>
          {isHe ? `שלחתי קוד SMS ל-${phone}` : `I sent an SMS code to ${phone}`}
        </p>
        <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>
          <input type="text" inputMode="numeric" placeholder={isHe ? "קוד בן 6 ספרות" : "6-digit code"} value={otpCode}
            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))} dir="ltr"
            autoComplete="one-time-code" maxLength={6}
            style={{ ...inputStyle, textAlign: "center", fontSize: 24, letterSpacing: "0.3em" }} />
          {error && <p style={{ fontSize: 13, color: "var(--accent)", textAlign: "center", margin: 0 }}>{error}</p>}
          <button onClick={handlePhoneVerify} disabled={loading || otpCode.length < 6}
            style={{ padding: 15, borderRadius: 14, background: "var(--dark)", color: "var(--white)", border: "none", cursor: loading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 500, fontFamily: "inherit", opacity: loading || otpCode.length < 6 ? 0.5 : 1 }}>
            {loading ? (isHe ? "מאמת..." : "Verifying...") : (isHe ? "אישור" : "Verify")}
          </button>
          <button onClick={() => { setMode("phone"); setError(null); setOtpCode(""); }}
            style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 8 }}>
            {isHe ? "→ שלחו קוד חדש" : "← Send new code"}
          </button>
        </div>
      </div>
    );
  }

  // ── Sign in / Sign up form ──
  return (
    <div style={{
      minHeight: "100dvh", background: "var(--cream)", display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "40px 24px", fontFamily: font,
    }} dir={dir}>
      <div style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800, fontSize: 36, letterSpacing: "0.04em",
          background: "linear-gradient(135deg, #E8725C, #D4507A)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.08))", marginBottom: 4 }}>sheli</div>
      <p style={{ fontSize: 13, color: "var(--muted)", fontWeight: isHe ? 400 : 300, marginBottom: 36, letterSpacing: isHe ? 0 : "0.03em" }}>{isHe ? "העוזרת החכמה של הבית והמשפחה" : "Your home & family's smart helper"}</p>

      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Mode toggle */}
        <div style={{ display: "flex", borderRadius: 12, overflow: "hidden", border: "1.5px solid var(--border)" }}>
          {["signin", "signup"].map((m) => (
            <button key={m} type="button" onClick={() => { setMode(m); setError(null); setLoading(false); setPassword(""); setConfirmPassword(""); }}
              style={{
                flex: 1, padding: "10px 0", border: "none",
                background: mode === m ? "var(--dark)" : "transparent",
                color: mode === m ? "var(--white)" : "var(--warm)",
                fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s",
              }}>
              {m === "signin" ? (isHe ? "התחברות" : "Sign In") : (isHe ? "הרשמה" : "Sign Up")}
            </button>
          ))}
        </div>

        {mode === "signup" && (
          <input type="text" placeholder={isHe ? "השם שלך" : "Your name"} value={displayName}
            onChange={(e) => setDisplayName(e.target.value)} dir={dir}
            style={{ ...inputStyle, textAlign: "start" }} />
        )}

        <input type="email" placeholder={isHe ? "אימייל" : "Email"} value={email}
          onChange={(e) => setEmail(e.target.value)} dir="ltr" required autoComplete="email"
          style={inputStyle} />

        <input type="password" placeholder={isHe ? "סיסמה" : "Password"} value={password}
          onChange={(e) => setPassword(e.target.value)} dir="ltr" required minLength={6}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          style={inputStyle} />

        {mode === "signup" && (
          <input type="password" placeholder={isHe ? "אימות סיסמה" : "Confirm password"} value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)} dir="ltr" required minLength={6}
            autoComplete="new-password" style={inputStyle} />
        )}

        {error && <p style={{ fontSize: 13, color: "var(--accent)", textAlign: "center", margin: 0 }}>{error}</p>}

        <button type="submit" disabled={loading}
          style={{ padding: 15, borderRadius: 14, background: "var(--dark)", color: "var(--white)", border: "none", cursor: loading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 500, fontFamily: "inherit", opacity: loading ? 0.5 : 1, transition: "background 0.2s" }}>
          {loading ? (isHe ? "רגע..." : "Loading...") : mode === "signin" ? (isHe ? "התחברו" : "Sign In") : (isHe ? "הירשמו" : "Sign Up")}
        </button>

        {/* Forgot password link (signin only) */}
        {mode === "signin" && (
          <button type="button" onClick={() => { setMode("forgot"); setError(null); }}
            style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit", padding: 2, textAlign: "center" }}>
            {isHe ? "שכחתם סיסמה?" : "Forgot password?"}
          </button>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "4px 0" }}>
          <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{isHe ? "או" : "or"}</span>
          <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
        </div>

        <button type="button" onClick={handleGoogle}
          style={{ padding: "13px 15px", borderRadius: 14, background: "var(--white)", border: "1.5px solid var(--border)", color: "var(--warm)", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, transition: "all 0.15s" }}>
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {isHe ? "המשיכו עם Google" : "Continue with Google"}
        </button>

        <button type="button" onClick={() => { setMode("phone"); setError(null); }}
          style={{ padding: "13px 15px", borderRadius: 14, background: "var(--white)", border: "1.5px solid var(--border)", color: "var(--warm)", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, transition: "all 0.15s" }}>
          <span style={{ fontSize: 18 }}>📱</span>
          {isHe ? "המשיכו עם מספר טלפון" : "Continue with phone number"}
        </button>
      </form>

      {onBack && (
        <button onClick={onBack}
          style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 8, marginTop: 8 }}>
          {isHe ? "→ חזרה" : "← Back"}
        </button>
      )}
    </div>
  );
}
