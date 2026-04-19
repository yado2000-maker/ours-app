// Cloud API template registry — Option 1 migration (plan Task 6, refined per Phase 0 P0.2).
//
// IMMUTABLE CONTRACT: editing a body requires a NEW template ID (e.g.
// reminder_fire_v2) + fresh Meta approval (24-72h). Do not edit in place.
//
// Submission order at plan Task 18:
//   P0 (cutover blockers):   reminder_fire, welcome_direct
//   P1 (group onboarding):   welcome_group, event_fire
//   P2 (future / comms):     morning_briefing, number_change_notice
//
// Positioning (design §4): Utility category only. Zero AI/LLM/chatbot framing.

export type TemplateId =
  | "reminder_fire"
  | "event_fire"
  | "welcome_direct"
  | "welcome_group"
  | "morning_briefing"
  | "number_change_notice";

interface TemplateDef {
  metaName: string;                      // name submitted to Meta (submission key)
  category: "UTILITY";
  language: "he";
  variables: string[];                   // ordered list of variable keys (for positional {{1}},{{2}},...)
  body: string;                          // rendering template with {{key}} placeholders
}

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  reminder_fire: {
    metaName: "reminder_fire",
    category: "UTILITY",
    language: "he",
    variables: ["reminderText"],
    body: "⏰ היי, תזכורת: {{reminderText}}",
  },

  event_fire: {
    metaName: "event_fire",
    category: "UTILITY",
    language: "he",
    variables: ["delta", "title"],
    body: "📅 בעוד {{delta}}: {{title}}",
  },

  // welcome_direct — refined per Phase 0 P0.2 + 2026-04-19 copy review.
  // Includes 4 concrete usage examples (reminders lead — #1 first action for
  // new users per FB launch data 2026-04-16), explicit forward-to-task tip,
  // voice-message tip, and a family-group CTA that also suggests creating a
  // new group. Under 1024-char Meta utility template body limit.
  welcome_direct: {
    metaName: "welcome_direct",
    category: "UTILITY",
    language: "he",
    variables: ["firstName"],
    body:
      "היי {{firstName}}! אני שלי, נעים מאד 🧡\n\n" +
      "אני מסדרת לכם רשימות קניות, תזכורות, מטלות ויומן - הכל בווטסאפ.\n\n" +
      "נסו לכתוב לי:\n" +
      "\"תזכירי לי מחר ב-18:00 להתקשר לאמא\"\n" +
      "\"תוסיפי לקניות חלב, לחם וביצים\"\n" +
      "\"פגישה ביום שלישי ב-10:00 אצל הרופא\"\n" +
      "\"שילמתי 250 ש\"ח על חשמל\"\n\n" +
      "💡 אפשר לעשות אליי \"העבר\" לכל הודעת ווטסאפ אחרת - ואוסיף למשימות.\n\n" +
      "🎤 ואפשר גם להקליט לי הודעה קולית.\n\n" +
      "ואני הכי יעילה בתיאום בין בני הבית - הוסיפו אותי לווטסאפ המשפחתי שלכם או צרו קבוצה חדשה וצרפו אותי, ואסדר הכל לכולם ✨",
  },

  welcome_group: {
    metaName: "welcome_group",
    category: "UTILITY",
    language: "he",
    variables: [],
    body:
      "שלום לכולם! אני שלי, נעים מאד 🧡\n\n" +
      "אני מסדרת למשפחה רשימות קניות, תזכורות, מטלות ויומן - הכל פה בקבוצה.\n\n" +
      "נסו לכתוב:\n" +
      "\"תזכירי לנו להוציא את הזבל ביום שלישי\"\n" +
      "\"להוסיף לקניות חלב ולחם\"\n" +
      "\"פגישה ביום חמישי ב-18:00 עם המורה\"\n\n" +
      "💡 אפשר לעשות אליי \"העבר\" לכל הודעת ווטסאפ אחרת - ואוסיף למשימות.\n\n" +
      "🎤 ואפשר גם להקליט לי הודעה קולית.\n\n" +
      "לצפייה ברשימות המלאות: sheli.ai",
  },

  morning_briefing: {
    metaName: "morning_briefing",
    category: "UTILITY",
    language: "he",
    variables: ["summary"],
    body: "בוקר טוב! מה להיום: {{summary}}.",
  },

  number_change_notice: {
    metaName: "number_change_notice",
    category: "UTILITY",
    language: "he",
    variables: ["newNumber"],
    body:
      "היי, זאת שלי! עברתי למספר חדש: {{newNumber}}.\n\n" +
      "שמרו את המספר והוסיפו לקבוצת הווטסאפ המשפחתית במקום הישן.",
  },
};

/**
 * Render a template body with the given variables. Used for (a) fallback /
 * legacy Whapi path that sends free-form text, and (b) local preview / tests.
 *
 * The Cloud API path DOES NOT use this — Meta renders the approved template
 * server-side using positional variables. See CloudApiProvider.sendTemplate.
 *
 * Throws if the template id is unknown or if any required variable is missing.
 */
export function renderTemplate<T extends TemplateId>(
  id: T,
  variables: Record<string, string>,
): string {
  const tpl = TEMPLATES[id];
  if (!tpl) throw new Error(`Unknown template: ${id}`);

  for (const required of tpl.variables) {
    if (!(required in variables)) {
      throw new Error(`Template ${id} missing variable: ${required}`);
    }
  }

  let rendered = tpl.body;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

/**
 * Convert the variables object to a positional array in the order declared
 * by the template. Used when calling Meta Cloud API's template send, which
 * expects {{1}}, {{2}}, ... positional placeholders.
 */
export function orderedVariables<T extends TemplateId>(
  id: T,
  variables: Record<string, string>,
): string[] {
  const tpl = TEMPLATES[id];
  if (!tpl) throw new Error(`Unknown template: ${id}`);
  return tpl.variables.map((key) => variables[key] ?? "");
}
