import { useState } from "react";
import T from "../locales/index.js";
import { supabase } from "../lib/supabase.js";

export default function AuthScreen({ onBack, lang = "en" }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup" | "check-email"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const t = T[lang] || T.en;
  const dir = t.dir;
  const isHe = lang === "he";
  const font = isHe ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";

  const redirectUrl = window.location.hostname === "localhost"
    ? window.location.origin : "https://sheli.ai";

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
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: displayName.trim() }, emailRedirectTo: redirectUrl },
        });
        if (error) throw error;
        // No session = needs email confirmation (or already registered with empty identities)
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
        // Session exists = auto-confirmed. Boot effect will pick it up via onAuthStateChange.
        // Just wait — don't setLoading(false), the screen will unmount when boot navigates.
        return;

      } else {
        // Sign in
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // Success — onAuthStateChange fires, boot effect navigates. Just wait.
        return;
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

  const handleGoogle = async () => {
    setError(null);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectUrl },
    });
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
          fontFamily: "'Cormorant Garamond', serif", fontWeight: 300,
          fontSize: 28, letterSpacing: "0.18em", color: "var(--dark)", marginBottom: 12,
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
          {isHe ? "לחצו על הקישור באימייל כדי להשלים את ההרשמה" : "Click the link in the email to complete your signup"}
        </p>
        <button onClick={() => { setMode("signin"); setError(null); }}
          style={{ padding: "12px 28px", borderRadius: 999, background: "var(--dark)", color: "var(--white)", border: "none", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", marginBottom: 12 }}>
          {isHe ? "← חזרה להתחברות" : "← Back to sign in"}
        </button>
        <button onClick={() => { setMode("signup"); setError(null); }}
          style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: 6 }}>
          {isHe ? "לא קיבלתי אימייל" : "Didn't get an email"}
        </button>
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
      <div style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 300, fontSize: 38, letterSpacing: "0.22em", color: "var(--dark)", marginBottom: 4 }}>Sheli</div>
      <p style={{ fontSize: 13, color: "var(--muted)", fontWeight: 300, marginBottom: 36, letterSpacing: "0.03em" }}>Smart AI for your life together</p>

      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Mode toggle */}
        <div style={{ display: "flex", borderRadius: 12, overflow: "hidden", border: "1.5px solid var(--border)" }}>
          {["signin", "signup"].map((m) => (
            <button key={m} type="button" onClick={() => { setMode(m); setError(null); setLoading(false); }}
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
            style={{ padding: "13px 15px", borderRadius: 12, border: "1.5px solid var(--border)", background: "var(--white)", fontSize: 15, color: "var(--dark)", outline: "none", fontFamily: "inherit", textAlign: "start" }} />
        )}

        <input type="email" placeholder={isHe ? "אימייל" : "Email"} value={email}
          onChange={(e) => setEmail(e.target.value)} dir="ltr" required autoComplete="email"
          style={{ padding: "13px 15px", borderRadius: 12, border: "1.5px solid var(--border)", background: "var(--white)", fontSize: 15, color: "var(--dark)", outline: "none", fontFamily: "inherit" }} />

        <input type="password" placeholder={isHe ? "סיסמה" : "Password"} value={password}
          onChange={(e) => setPassword(e.target.value)} dir="ltr" required minLength={6}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          style={{ padding: "13px 15px", borderRadius: 12, border: "1.5px solid var(--border)", background: "var(--white)", fontSize: 15, color: "var(--dark)", outline: "none", fontFamily: "inherit" }} />

        {error && <p style={{ fontSize: 13, color: "var(--accent)", textAlign: "center", margin: 0 }}>{error}</p>}

        <button type="submit" disabled={loading}
          style={{ padding: 15, borderRadius: 14, background: "var(--dark)", color: "var(--white)", border: "none", cursor: loading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 500, fontFamily: "inherit", opacity: loading ? 0.5 : 1, transition: "background 0.2s" }}>
          {loading ? (isHe ? "רגע..." : "Loading...") : mode === "signin" ? (isHe ? "התחבר" : "Sign In") : (isHe ? "היירשם" : "Sign Up")}
        </button>

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
          {isHe ? "המשך עם Google" : "Continue with Google"}
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
