import { useState, useEffect } from "react";
import T from "../../locales/index.js";
import { analytics, track } from "../../lib/analytics.js";
import { loadReferralStats } from "../../lib/supabase.js";

export default function MenuPanel({
  user,
  household,
  lang,
  theme,
  isFounder,
  onClose,
  onRenameUser,
  onRenameMember,
  onRenameHousehold,
  onAddMember,
  onRemoveMember,
  onSwitchLang,
  onSetTheme,
  onSwitchUser,
  onSignOut,
  onReset,
}) {
  const [editingName, setEditingName] = useState(false);
  const [editingHhName, setEditingHhName] = useState(false);
  const [newName, setNewName] = useState("");
  const [newHhName, setNewHhName] = useState("");
  const [newMemberName, setNewMemberName] = useState("");
  const [copied, setCopied] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState(null); // M12: confirm before remove
  const [editingMemberId, setEditingMemberId] = useState(null);
  const [editMemberName, setEditMemberName] = useState("");
  const [referralCopied, setReferralCopied] = useState(false);
  const [referralStats, setReferralStats] = useState({ sent: 0, completed: 0 });

  const t = T[lang] || T.en;
  const dir = lang === "he" ? "rtl" : "ltr";
  const isHe = lang === "he";

  // M5 fix: close on Escape key
  useEffect(() => {
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);
  const referralCode = household?.referralCode;
  const referralLink = referralCode ? `https://sheli.ai/r/${referralCode}` : "";

  useEffect(() => {
    if (household?.id) {
      loadReferralStats(household.id).then(setReferralStats);
    }
  }, [household?.id]);

  const font = isHe ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";
  const joinUrl =
    typeof window !== "undefined"
      ? window.location.origin + "/?join=" + (household?.id || "")
      : "";

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        dir={dir}
        onClick={(e) => e.stopPropagation()}
        style={{
          fontFamily: font,
          maxHeight: "85dvh",
          overflowY: "auto",
          position: "relative",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 12,
            insetInlineEnd: 12,
            background: "none",
            border: "none",
            fontSize: 20,
            color: "var(--muted)",
            cursor: "pointer",
            padding: 4,
          }}
        >
          ×
        </button>

        {/* 1. Profile section */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "var(--accent)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {user?.name?.[0]?.toUpperCase() || "?"}
          </div>
          <div style={{ flex: 1 }}>
            {editingName ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1.5px solid var(--border)",
                    fontSize: 15,
                    fontFamily: "inherit",
                    color: "var(--dark)",
                    outline: "none",
                    textAlign: "start",
                  }}
                  dir={dir}
                />
                <button
                  onClick={() => {
                    if (newName.trim()) {
                      onRenameUser(newName.trim());
                      setEditingName(false);
                    }
                  }}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    background: "var(--warm)",
                    color: "#fff",
                    border: "none",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {t.menuSaveName}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: 17,
                    fontWeight: 500,
                    color: "var(--dark)",
                  }}
                >
                  {user?.name || ""}
                </span>
                <button
                  onClick={() => {
                    setNewName(user?.name || "");
                    setEditingName(true);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    padding: 2,
                  }}
                >
                  ✏️
                </button>
              </div>
            )}
            <div
              style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}
            >
              {household?.name || ""}
            </div>
          </div>
        </div>

        {/* Switch user link */}
        <button
          onClick={() => {
            onSwitchUser();
            onClose();
          }}
          style={{
            background: "none",
            border: "none",
            color: "var(--accent)",
            fontSize: 13,
            cursor: "pointer",
            fontFamily: "inherit",
            padding: "0 0 16px",
            textAlign: "start",
          }}
        >
          {t.menuSwitchUser}
        </button>

        {/* Divider */}
        <div
          style={{ height: 1.5, background: "var(--border)", margin: "4px 0 16px" }}
        />

        {/* 2. Household section */}
        <div className="section-head" style={{ marginBottom: 8 }}>
          {t.menuHome}
        </div>

        {/* Household name */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
            {t.menuHhName}
          </div>
          {editingHhName ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                value={newHhName}
                onChange={(e) => setNewHhName(e.target.value)}
                autoFocus
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1.5px solid var(--border)",
                  fontSize: 14,
                  fontFamily: "inherit",
                  color: "var(--dark)",
                  outline: "none",
                  textAlign: "start",
                }}
                dir={dir}
              />
              <button
                onClick={() => {
                  if (newHhName.trim()) {
                    onRenameHousehold(newHhName.trim());
                    setEditingHhName(false);
                  }
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  background: "var(--warm)",
                  color: "#fff",
                  border: "none",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {t.menuSaveName}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: "var(--dark)",
                }}
              >
                {household?.name || ""}
              </span>
              <button
                  onClick={() => {
                    setNewHhName(household?.name || "");
                    setEditingHhName(true);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    padding: 2,
                  }}
                >
                  ✏️
                </button>
            </div>
          )}
        </div>

        {/* Members */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
            {t.menuMembers}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(household?.members || []).map((m) => (
              <div
                key={m.id || m.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "5px 10px",
                  borderRadius: 100,
                  border: `1.5px solid ${m.id === user?.id ? "var(--primary)" : "var(--border)"}`,
                  background: "var(--white)",
                  fontSize: 13,
                  color: "var(--warm)",
                }}
              >
                {editingMemberId === m.id ? (
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <input
                      value={editMemberName}
                      onChange={(e) => setEditMemberName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editMemberName.trim()) {
                          if (m.id === user?.id) { onRenameUser(editMemberName.trim()); }
                          else { onRenameMember?.(m.id, editMemberName.trim()); }
                          setEditingMemberId(null);
                        }
                        if (e.key === "Escape") setEditingMemberId(null);
                      }}
                      style={{ width: 70, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 12, fontFamily: "inherit", color: "var(--dark)", outline: "none", textAlign: "start" }}
                      dir={dir}
                    />
                    <button onClick={() => {
                      if (editMemberName.trim()) {
                        if (m.id === user?.id) { onRenameUser(editMemberName.trim()); }
                        else { onRenameMember?.(m.id, editMemberName.trim()); }
                      }
                      setEditingMemberId(null);
                    }}
                      style={{ background: "var(--primary)", color: "#fff", border: "none", fontSize: 10, borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit" }}>
                      ✓
                    </button>
                  </div>
                ) : (
                  <>
                    <span>{m.name}</span>
                    {/* Edit: anyone can edit any member name */}
                    <button
                      onClick={() => { setEditMemberName(m.name); setEditingMemberId(m.id); }}
                      style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 10, cursor: "pointer", padding: 0, lineHeight: 1 }}
                    >
                      ✏️
                    </button>
                  </>
                )}
                {/* Remove: any user can remove others (not self), not while editing */}
                {m.id !== user?.id && editingMemberId !== m.id && (
                  removingMemberId === m.id ? (
                    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                      <button onClick={() => { onRemoveMember(m.id); setRemovingMemberId(null); }}
                        style={{ background: "#c33", color: "#fff", border: "none", fontSize: 10, borderRadius: 4, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit" }}>
                        {isHe ? "הסירו" : "Remove"}
                      </button>
                      <button onClick={() => setRemovingMemberId(null)}
                        style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 10, cursor: "pointer", fontFamily: "inherit", padding: "2px 4px" }}>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRemovingMemberId(m.id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--muted)",
                        fontSize: 14,
                        cursor: "pointer",
                        padding: 0,
                        lineHeight: 1,
                        opacity: 0.5,
                      }}
                    >
                      ×
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <input
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                placeholder={t.menuAddMemberPlaceholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newMemberName.trim()) {
                    onAddMember(newMemberName.trim());
                    setNewMemberName("");
                  }
                }}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1.5px solid var(--border)",
                  fontSize: 13,
                  fontFamily: "inherit",
                  color: "var(--dark)",
                  outline: "none",
                  textAlign: "start",
                }}
                dir={dir}
              />
              <button
                onClick={() => {
                  if (newMemberName.trim()) {
                    onAddMember(newMemberName.trim());
                    setNewMemberName("");
                  }
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  background: "var(--warm)",
                  color: "#fff",
                  border: "none",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  whiteSpace: "nowrap",
                }}
              >
                {t.menuAddMember}
              </button>
            </div>
        </div>

        <div
          style={{ height: 1.5, background: "var(--border)", margin: "4px 0 16px" }}
        />

        {/* 3. Invite member to household */}
        <div className="section-head" style={{ marginBottom: 4 }}>
          {typeof t.menuInvite === "function" ? t.menuInvite(household?.name || "") : t.menuInvite}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10, lineHeight: 1.4 }}>
          {t.menuInviteDesc}
        </div>
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "var(--cream)",
            border: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--warm)",
            wordBreak: "break-all",
            direction: "ltr",
            marginBottom: 8,
            userSelect: "all",
          }}
        >
          {joinUrl}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(joinUrl);
                setCopied(true);
                analytics.memberInviteSent("copy_link");
                setTimeout(() => setCopied(false), 2000);
              } catch { /* clipboard not available (HTTP/iframe) — don't show false success */ }
            }}
            style={{
              flex: 1,
              padding: "10px",
              borderRadius: 10,
              background: copied ? "var(--green)" : "var(--warm)",
              color: "#fff",
              border: "none",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "background 0.2s",
            }}
          >
            {copied ? t.menuLinkCopied : t.menuCopyLink}
          </button>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(
              isHe
                ? "\u05D4\u05E6\u05D8\u05E8\u05E4\u05D5 \u05D0\u05DC\u05D9\u05D9 \u05D1-Sheli: " + joinUrl
                : "Join me on Sheli: " + joinUrl
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => analytics.memberInviteSent("whatsapp")}
            style={{
              flex: 1,
              padding: "10px",
              borderRadius: 10,
              background: "#25D366",
              color: "#fff",
              border: "none",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              textDecoration: "none",
              textAlign: "center",
              display: "block",
            }}
          >
            {t.menuShareWa}
          </a>
        </div>

        {/* 4. WhatsApp Bot */}
        <div className="section-head" style={{ marginBottom: 4 }}>
          {t.menuWhatsApp}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10, lineHeight: 1.4 }}>
          {t.menuWaDesc}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: 10,
            background: "var(--cream)",
            border: "1px solid var(--border)",
            marginBottom: 16,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 2 }}>
              sheli
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--dark)",
                direction: "ltr",
                textAlign: dir === "rtl" ? "end" : "start",
                fontFamily: "'DM Sans',sans-serif",
              }}
            >
              +972 55-517-5553
            </div>
          </div>
          <a
            href="https://wa.me/972555175553?text=%D7%A9%D7%9C%D7%95%D7%9D%20%D7%A9%D7%9C%D7%99"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              background: "#25D366",
              color: "#fff",
              fontSize: 12,
              fontWeight: 500,
              textDecoration: "none",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
            }}
          >
            {t.waSettingsBtn}
          </a>
        </div>

        <div
          style={{ height: 1.5, background: "var(--border)", margin: "4px 0 16px" }}
        />

        {/* 5. Preferences */}
        <div className="section-head" style={{ marginBottom: 8 }}>
          {t.menuPrefs}
        </div>

        {/* Language toggle */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderRadius: 10,
            overflow: "hidden",
            border: "1.5px solid var(--border)",
            marginBottom: 10,
          }}
        >
          {["en", "he"].map((l) => (
            <button
              key={l}
              onClick={() => onSwitchLang(l)}
              style={{
                flex: 1,
                padding: "8px 0",
                border: "none",
                background: lang === l ? "var(--warm)" : "transparent",
                color: lang === l ? "#fff" : "var(--warm)",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "'DM Sans',sans-serif",
                transition: "all 0.15s",
              }}
            >
              {l === "en" ? "English" : "\u05E2\u05D1\u05E8\u05D9\u05EA"}
            </button>
          ))}
        </div>

        {/* Theme toggle */}
        <div
          style={{
            display: "flex",
            gap: 0,
            borderRadius: 10,
            overflow: "hidden",
            border: "1.5px solid var(--border)",
            marginBottom: 16,
          }}
        >
          {[
            ["light", isHe ? "\u05D1\u05D4\u05D9\u05E8" : "Light"],
            ["dark", isHe ? "\u05DB\u05D4\u05D4" : "Dark"],
            ["auto", isHe ? "\u05D0\u05D5\u05D8\u05D5\u05DE\u05D8\u05D9" : "Auto"],
          ].map(([val, label]) => (
            <button
              key={val}
              onClick={() => { analytics.themeChanged(val); onSetTheme(val); }}
              style={{
                flex: 1,
                padding: "8px 0",
                border: "none",
                background: theme === val ? "var(--warm)" : "transparent",
                color: theme === val ? "#fff" : "var(--warm)",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "all 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          style={{ height: 1.5, background: "var(--border)", margin: "4px 0 16px" }}
        />

        {/* 6. Family brings Family — promotional card */}
        {referralCode && (
          <>
            <div
              style={{
                padding: "16px",
                borderRadius: 14,
                background: "linear-gradient(135deg, #FFF0ED 0%, #FFF7F5 100%)",
                border: "1.5px solid #F0C4BB",
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--dark)", marginBottom: 6 }}>
                🎁 {t.menuReferral}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12, lineHeight: 1.5 }}>
                {t.menuReferralDesc}
              </div>
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: "#fff",
                  border: "1px solid #F0C4BB",
                  fontSize: 11.5,
                  color: "var(--warm)",
                  wordBreak: "break-all",
                  direction: "ltr",
                  marginBottom: 10,
                  userSelect: "all",
                }}
              >
                {referralLink}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(referralLink);
                      setReferralCopied(true);
                      track("referral_link_copied");
                      setTimeout(() => setReferralCopied(false), 2000);
                    } catch {}
                  }}
                  style={{
                    flex: "0 0 auto",
                    padding: "9px 16px",
                    borderRadius: 10,
                    background: referralCopied ? "var(--green)" : "#fff",
                    color: referralCopied ? "#fff" : "var(--coral, #E8725C)",
                    border: referralCopied ? "none" : "1.5px solid var(--coral, #E8725C)",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.2s",
                  }}
                >
                  {referralCopied ? t.menuReferralCopied : t.menuReferralCopy}
                </button>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(
                    isHe
                      ? "\u05D4\u05D9\u05D9! \u05EA\u05E0\u05E1\u05D5 \u05D0\u05EA \u05E9\u05DC\u05D9 \u2014 \u05E2\u05D5\u05D6\u05E8\u05EA \u05D7\u05DB\u05DE\u05D4 \u05DC\u05DE\u05E9\u05E4\u05D7\u05D4 \u05D1\u05D5\u05D5\u05D8\u05E1\u05D0\u05E4 \uD83C\uDFE0\n" + referralLink
                      : "Hey! Try Sheli \u2014 a smart family helper on WhatsApp \uD83C\uDFE0\n" + referralLink
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => track("referral_link_shared_wa")}
                  style={{
                    flex: 1,
                    padding: "9px 16px",
                    borderRadius: 10,
                    background: "var(--warm)",
                    color: "#fff",
                    border: "none",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textDecoration: "none",
                    textAlign: "center",
                    display: "block",
                  }}
                >
                  {t.menuReferralShare}
                </a>
              </div>
              {referralStats.sent > 0 && (
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                  {typeof t.menuReferralStats === "function"
                    ? t.menuReferralStats(referralStats.sent, referralStats.completed)
                    : ""}
                </div>
              )}
            </div>

            <div
              style={{ height: 1.5, background: "var(--border)", margin: "4px 0 16px" }}
            />
          </>
        )}

        {/* 7. Account */}
        <div className="section-head" style={{ marginBottom: 8 }}>
          {t.menuAccount}
        </div>
        <button
          onClick={() => {
            onSignOut();
            onClose();
          }}
          style={{
            width: "100%",
            padding: "11px",
            borderRadius: 10,
            background: "transparent",
            border: "1.5px solid var(--border)",
            color: "var(--warm)",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: "inherit",
            textAlign: "center",
            marginBottom: 8,
          }}
        >
          {t.menuSignOut}
        </button>

        {isFounder && (
          <>
            {!showResetConfirm ? (
              <button
                onClick={() => setShowResetConfirm(true)}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--muted)",
                  fontSize: 12,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: 4,
                  opacity: 0.6,
                }}
              >
                {t.menuReset}
              </button>
            ) : (
              <div
                style={{
                  padding: "12px",
                  borderRadius: 10,
                  border: "1.5px solid #c33",
                  background: "rgba(200,50,50,0.05)",
                }}
              >
                <p
                  style={{
                    fontSize: 13,
                    color: "#c33",
                    marginBottom: 8,
                    textAlign: "center",
                  }}
                >
                  {isHe
                    ? "\u05D1\u05D8\u05D5\u05D7\u05D9\u05DD? \u05D6\u05D4 \u05D9\u05DE\u05D7\u05E7 \u05D4\u05DB\u05DC."
                    : "Are you sure? This deletes everything."}
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setShowResetConfirm(false)}
                    style={{
                      flex: 1,
                      padding: "8px",
                      borderRadius: 8,
                      background: "var(--cream)",
                      border: "1px solid var(--border)",
                      color: "var(--warm)",
                      fontSize: 12,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {isHe ? "\u05D1\u05D9\u05D8\u05D5\u05DC" : "Cancel"}
                  </button>
                  <button
                    onClick={() => {
                      onReset();
                      onClose();
                    }}
                    style={{
                      flex: 1,
                      padding: "8px",
                      borderRadius: 8,
                      background: "#c33",
                      color: "#fff",
                      border: "none",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {isHe ? "\u05DE\u05D7\u05D9\u05E7\u05D4" : "Delete"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
