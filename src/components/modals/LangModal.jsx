import T from "../../locales/index.js";

export default function LangModal({ lang, onSelect, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="lang-switch-modal" dir={lang === "he" ? "rtl" : "ltr"} onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{fontFamily:"'Cormorant Garamond',serif"}}>
          {lang === "he" ? T.he.langStep : T.en.langStep}
        </div>
        <div className="lang-cards">
          {[{code:"en",label:"EN",sub:"English"},{code:"he",label:"HE",sub:"\u05E2\u05D1\u05E8\u05D9\u05EA"}].map(l => (
            <div key={l.code} className={`lang-card ${lang===l.code?"selected":""}`} onClick={() => onSelect(l.code)}>
              <span className="lang-flag">{l.label}</span>
              <span className="lang-name">{l.sub}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
