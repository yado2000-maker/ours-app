// Google Analytics 4 (gtag.js) loader.
// Called from main.jsx; caller is responsible for gating (admin skip).
const GA_MEASUREMENT_ID = "G-8XQVSDTBJT";

export function initGA4() {
  if (typeof window === "undefined") return;
  if (window.__ga4Inited) return;
  window.__ga4Inited = true;

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID);
}
