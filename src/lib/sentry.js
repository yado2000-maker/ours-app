// Sentry error tracking wrapper
// Uses Sentry CDN loader to avoid bundle size impact

let sentryInitialized = false;

export const initSentry = () => {
  if (typeof window === "undefined") return;

  const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;
  if (!SENTRY_DSN) {
    console.warn("[Sentry] No VITE_SENTRY_DSN set — error tracking disabled");
    return;
  }

  // Dynamic import to keep bundle small
  import("https://browser.sentry-cdn.com/8.0.0/bundle.min.js").then(() => {
    if (window.Sentry) {
      window.Sentry.init({
        dsn: SENTRY_DSN,
        environment: import.meta.env.MODE || "production",
        tracesSampleRate: 0.1, // 10% of transactions
        replaysSessionSampleRate: 0, // No session replays (free tier)
        replaysOnErrorSampleRate: 0.5, // 50% of error sessions
      });
      sentryInitialized = true;
    }
  }).catch(() => {
    // Sentry CDN failed to load — silently continue
    console.warn("[Sentry] CDN failed to load");
  });
};

export const captureError = (error, context = {}) => {
  console.error("[Error]", error, context);
  if (sentryInitialized && window.Sentry) {
    window.Sentry.captureException(error, {
      extra: context,
    });
  }
};

export const setUser = (userId, email) => {
  if (sentryInitialized && window.Sentry) {
    window.Sentry.setUser({ id: userId, email });
  }
};

export default { initSentry, captureError, setUser };
