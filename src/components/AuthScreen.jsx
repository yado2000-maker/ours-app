import { useState } from "react";
import T from "../locales/index.js";
import { useAuth } from "../hooks/useAuth.js";

export default function AuthScreen({ onAuthSuccess, onBack, lang = "en" }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const { signIn, signUp, signInWithGoogle } = useAuth();

  const t = T[lang] || T.en;
  const dir = t.dir;
  const isHe = lang === "he";
  const font = isHe ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === "signup") {
        if (!displayName.trim()) {
          setError(isHe ? "\u05e0\u05d0 \u05dc\u05d4\u05d6\u05d9\u05df \u05e9\u05dd" : "Please enter your name");
          setLoading(false);
          return;
        }
        const { error } = await signUp(email, password, displayName.trim());
        if (error) throw error;
        // After signup, profile is auto-created by trigger
        onAuthSuccess?.();
      } else {
        const { error } = await signIn(email, password);
        if (error) throw error;
        onAuthSuccess?.();
      }
    } catch (err) {
      const msg = err.message || "";
      if (msg.includes("already registered") || msg.includes("already been registered")) {
        setError(isHe ? "כבר יש חשבון עם האימייל הזה. נסו התחברות" : "Already registered. Try signing in instead");
        setMode("signin");
      } else if (msg.includes("Invalid login")) {
        setError(isHe ? "אימייל או סיסמה לא נכונים" : "Wrong email or password");
      } else {
        setError(msg || (isHe ? "משהו השתבש" : "Something went wrong"));
      }
    }
    setLoading(false);
  };

  const handleGoogle = async () => {
    setError(null);
    const { error } = await signInWithGoogle();
    if (error) setError(error.message);
  };

  return (
    <div style={{
      minHeight: "100dvh",
      background: "var(--cream)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "40px 24px",
      fontFamily: font,
    }} dir={dir}>
      {/* Wordmark */}
      <div style={{
        fontFamily: "'Cormorant Garamond', serif",
        fontWeight: 300,
        fontSize: 38,
        letterSpacing: "0.22em",
        color: "var(--dark)",
        marginBottom: 4,
      }}>Sheli</div>
      <p style={{
        fontSize: 13,
        color: "var(--muted)",
        fontWeight: 300,
        marginBottom: 36,
        letterSpacing: "0.03em",
      }}>Smart AI for your life together</p>

      {/* Auth form */}
      <form onSubmit={handleSubmit} style={{
        width: "100%",
        maxWidth: 340,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}>
        {/* Mode toggle */}
        <div style={{
          display: "flex",
          gap: 0,
          borderRadius: 12,
          overflow: "hidden",
          border: "1.5px solid var(--border)",
        }}>
          {["signin", "signup"].map((m) => (
            <button key={m} type="button" onClick={() => { setMode(m); setError(null); }}
              style={{
                flex: 1,
                padding: "10px 0",
                border: "none",
                background: mode === m ? "var(--dark)" : "transparent",
                color: mode === m ? "var(--white)" : "var(--warm)",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "all 0.2s ease",
              }}>
              {m === "signin"
                ? (isHe ? "\u05d4\u05ea\u05d7\u05d1\u05e8\u05d5\u05ea" : "Sign In")
                : (isHe ? "\u05d4\u05e8\u05e9\u05de\u05d4" : "Sign Up")}
            </button>
          ))}
        </div>

        {/* Display name (signup only) */}
        {mode === "signup" && (
          <input
            type="text"
            placeholder={isHe ? "\u05d4\u05e9\u05dd \u05e9\u05dc\u05da" : "Your name"}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            dir={dir}
            style={{
              padding: "13px 15px",
              borderRadius: 12,
              border: "1.5px solid var(--border)",
              background: "var(--white)",
              fontSize: 15,
              color: "var(--dark)",
              outline: "none",
              fontFamily: "inherit",
              textAlign: "start",
            }}
          />
        )}

        {/* Email */}
        <input
          type="email"
          placeholder={isHe ? "\u05d0\u05d9\u05de\u05d9\u05d9\u05dc" : "Email"}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
          required
          style={{
            padding: "13px 15px",
            borderRadius: 12,
            border: "1.5px solid var(--border)",
            background: "var(--white)",
            fontSize: 15,
            color: "var(--dark)",
            outline: "none",
            fontFamily: "inherit",
          }}
        />

        {/* Password */}
        <input
          type="password"
          placeholder={isHe ? "\u05e1\u05d9\u05e1\u05de\u05d4" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          dir="ltr"
          required
          minLength={6}
          style={{
            padding: "13px 15px",
            borderRadius: 12,
            border: "1.5px solid var(--border)",
            background: "var(--white)",
            fontSize: 15,
            color: "var(--dark)",
            outline: "none",
            fontFamily: "inherit",
          }}
        />

        {/* Error */}
        {error && (
          <p style={{
            fontSize: 13,
            color: "var(--accent)",
            textAlign: "center",
            margin: 0,
          }}>{error}</p>
        )}

        {/* Submit */}
        <button type="submit" disabled={loading}
          style={{
            padding: 15,
            borderRadius: 14,
            background: "var(--dark)",
            color: "var(--white)",
            border: "none",
            cursor: loading ? "not-allowed" : "pointer",
            fontSize: 15,
            fontWeight: 500,
            fontFamily: "inherit",
            opacity: loading ? 0.5 : 1,
            transition: "background 0.2s",
          }}>
          {loading
            ? (isHe ? "\u05e8\u05d2\u05e2..." : "Loading...")
            : mode === "signin"
              ? (isHe ? "\u05d4\u05ea\u05d7\u05d1\u05e8" : "Sign In")
              : (isHe ? "\u05d4\u05d9\u05e8\u05e9\u05dd" : "Sign Up")}
        </button>

        {/* Divider */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          margin: "4px 0",
        }}>
          <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {isHe ? "\u05d0\u05d5" : "or"}
          </span>
          <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
        </div>

        {/* Google OAuth */}
        <button type="button" onClick={handleGoogle}
          style={{
            padding: "13px 15px",
            borderRadius: 14,
            background: "var(--white)",
            border: "1.5px solid var(--border)",
            color: "var(--warm)",
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: "inherit",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            transition: "all 0.15s",
          }}>
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {isHe ? "\u05d4\u05de\u05e9\u05da \u05e2\u05dd Google" : "Continue with Google"}
        </button>
      </form>

      {/* Back button */}
      {onBack && (
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            color: "var(--muted)",
            fontSize: 13,
            cursor: "pointer",
            fontFamily: "inherit",
            padding: 8,
            marginTop: 8,
          }}
        >
          {isHe ? "→ חזרה" : "← Back"}
        </button>
      )}
    </div>
  );
}
