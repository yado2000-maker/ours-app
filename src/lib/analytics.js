// Analytics wrapper for PostHog + custom events
// PostHog free tier: 1M events/month

let posthog = null;

export const initAnalytics = () => {
  // PostHog initialization - loads async from CDN to avoid bundle size
  if (typeof window === "undefined") return;

  const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY;
  if (!POSTHOG_KEY) {
    if (import.meta.env.DEV) console.info("[Analytics] No VITE_POSTHOG_KEY — disabled");
    return;
  }

  // Load PostHog from CDN
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init(POSTHOG_KEY, {
    api_host: "https://us.i.posthog.com",
    person_profiles: "identified_only",
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false, // We'll track specific events
  });

  posthog = window.posthog;
};

// Identify user after auth
export const identifyUser = (userId, properties = {}) => {
  if (!posthog && window.posthog) posthog = window.posthog;
  posthog?.identify(userId, properties);
};

// Track custom events
export const track = (event, properties = {}) => {
  if (!posthog && window.posthog) posthog = window.posthog;
  posthog?.capture(event, properties);
};

// Pre-defined event helpers for key conversion funnel events
export const analytics = {
  // Onboarding
  signupStarted: (method) => track("signup_started", { method }),
  signupCompleted: (method) => track("signup_completed", { method }),
  signinCompleted: (method) => track("signin_completed", { method }),

  // Household lifecycle
  householdCreated: (lang, memberCount) => track("household_created", { lang, member_count: memberCount }),
  memberJoined: (householdId) => track("member_joined", { household_id: householdId }),
  memberInviteSent: (method) => track("member_invite_sent", { method }), // "whatsapp" | "copy_link"

  // Core engagement
  aiMessageSent: (lang) => track("ai_message_sent", { lang }),
  aiMessageReceived: (lang, hadTasks, hadShopping, hadEvents) =>
    track("ai_message_received", { lang, had_tasks: hadTasks, had_shopping: hadShopping, had_events: hadEvents }),
  taskCreated: () => track("task_created"),
  taskCompleted: () => track("task_completed"),
  shoppingItemAdded: () => track("shopping_item_added"),
  shoppingItemGot: () => track("shopping_item_got"),
  eventCreated: () => track("event_created"),

  // Monetization
  paywallShown: (trigger) => track("paywall_shown", { trigger }), // "ai_limit" | "member_limit" | "feature_gate"
  paywallDismissed: () => track("paywall_dismissed"),
  subscriptionStarted: (plan, price) => track("subscription_started", { plan, price }),
  subscriptionCanceled: (plan, reason) => track("subscription_canceled", { plan, reason }),

  // Engagement
  voiceInputUsed: (lang) => track("voice_input_used", { lang }),
  languageSwitched: (from, to) => track("language_switched", { from, to }),
  themeChanged: (theme) => track("theme_changed", { theme }),

  // Referral
  referralLinkGenerated: () => track("referral_link_generated"),
  referralCompleted: () => track("referral_completed"),
};

export default analytics;
