import { useState } from "react";
import { uid } from "../lib/supabase.js";
import T from "../locales/index.js";

export default function Setup({ onDone, initialLang }) {
  const [step, setStep]       = useState(initialLang ? 1 : 0);
  const [lang, setLang]       = useState(initialLang || null);
  const [hhName, setHhName]   = useState("");
  const [members, setMembers] = useState([]);
  const [newM, setNewM]       = useState("");

  const t = lang ? T[lang] : T.en;
  const dir = lang === "he" ? "rtl" : "ltr";

  const addMember = () => {
    const n = newM.trim();
    if (!n || members.find(m => m.name.toLowerCase() === n.toLowerCase())) return;
    setMembers(p => [...p, { id: uid(), name: n }]);
    setNewM("");
  };

  const selectLang = (l) => { setLang(l); setTimeout(() => setStep(1), 160); };

  return (
    <div className="setup-wrap" dir={dir} style={{ fontFamily: lang === "he" ? "'Heebo',sans-serif" : "'DM Sans',sans-serif" }}>
      <div className="setup-mark">Sheli</div>
      <p className="setup-tagline">Smart AI for your life together</p>

      <div className="setup-form">
        {step === 0 && (
          <>
            <p className="step-label">{lang === "he" ? T.he.langStep : T.en.langStep}</p>
            <div className="lang-cards">
              {[{code:"en",label:"EN",sub:"English"},{code:"he",label:"HE",sub:"\u05E2\u05D1\u05E8\u05D9\u05EA"}].map(l => (
                <div key={l.code} className={`lang-card ${lang===l.code?"selected":""}`} onClick={() => selectLang(l.code)}>
                  <span className="lang-flag">{l.label}</span>
                  <span className="lang-name">{l.sub}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="field">
              <label className="field-label">{t.hhLabel}</label>
              <input className="field-input" placeholder={t.hhPlaceholder} value={hhName}
                onChange={e => setHhName(e.target.value)} dir={dir} />
            </div>
            <div className="field">
              <label className="field-label">{t.whoLabel}</label>
              {t.whoSub && <p className="field-sub">{t.whoSub}</p>}
              {members.length > 0 && (
                <div className="tags">
                  {members.map(m => (
                    <div className="tag" key={m.id}>{m.name}
                      <button className="tag-x" onClick={() => setMembers(p => p.filter(x => x.id !== m.id))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="add-row">
                <input className="add-input" placeholder={t.addPlaceholder} value={newM} dir={dir}
                  onChange={e => setNewM(e.target.value)} onKeyDown={e => e.key === "Enter" && addMember()} />
                <button className="add-mini" onClick={addMember}>{t.addBtn}</button>
              </div>
            </div>
            <button className="go-btn" disabled={!hhName.trim() || members.length < 1}
              onClick={() => onDone({ name: hhName.trim(), members, lang })}>
              {t.goBtn}
            </button>
            <button className="back-btn" onClick={() => setStep(0)}>
              {lang === "he" ? "\u2192 \u05E9\u05D9\u05E0\u05D5\u05D9 \u05E9\u05E4\u05D4" : "\u2190 Change language"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
