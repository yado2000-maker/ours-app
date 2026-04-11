// Test cases for Hebrew family WhatsApp message intent classifier
// 120+ cases covering all 9 intents + edge cases

export interface TestCase {
  input: string;        // Message text
  sender: string;       // Sender name
  expectedIntent: string;
  expectedEntities?: Record<string, unknown>;
  notes?: string;       // Why this case is interesting
}

// ─── Mock household context (used by all test cases) ───
export const MOCK_CONTEXT = {
  householdName: "משפחת כהן",
  members: ["אמא", "אבא", "נועה", "יונתן"],
  language: "he",
  openTasks: [
    { id: "t1a2", title: "לשטוף כלים", assigned_to: "אבא" },
    { id: "t3b4", title: "לקבוע תור לרופא שיניים", assigned_to: null },
    { id: "t5c6", title: "לסדר את הארון", assigned_to: "נועה" },
    { id: "t7d8", title: "לקנות מתנה לסבתא", assigned_to: "אמא" },
  ],
  openShopping: [
    { id: "s1a2", name: "חלב", qty: "2" },
    { id: "s3b4", name: "ביצים", qty: "1" },
    { id: "s5c6", name: "לחם", qty: null },
    { id: "s7d8", name: "אבקת כביסה", qty: "1" },
  ],
};

// ─── IGNORE (25 cases) ───
// Social noise, greetings, reactions — should NEVER trigger actions

export const IGNORE_CASES: TestCase[] = [
  {
    input: "בוקר טוב!",
    sender: "אמא",
    expectedIntent: "ignore",
    notes: "Standard morning greeting",
  },
  {
    input: "לילה טוב חמודים",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "Goodnight greeting",
  },
  {
    input: "😂😂😂",
    sender: "נועה",
    expectedIntent: "ignore",
    notes: "Emoji-only reaction",
  },
  {
    input: "👍",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "Thumbs up — confirmation/reaction, not a task claim",
  },
  {
    input: "❤️",
    sender: "אמא",
    expectedIntent: "ignore",
    notes: "Heart emoji reaction",
  },
  {
    input: "אמן",
    sender: "אמא",
    expectedIntent: "ignore",
    notes: "Religious expression",
  },
  {
    input: "בהצלחה!",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "Good luck wish",
  },
  {
    input: "סבבה",
    sender: "נועה",
    expectedIntent: "ignore",
    notes: "Slang acknowledgment (no actionable context)",
  },
  {
    input: "אחלה",
    sender: "יונתן",
    expectedIntent: "ignore",
    notes: "Slang praise",
  },
  {
    input: "הגענו בשלום",
    sender: "אמא",
    expectedIntent: "ignore",
    notes: "Status update — arrived safely",
  },
  {
    input: "ראיתם את התוכנית אתמול? מטורף",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "TV show discussion — social chatter",
  },
  {
    input: "חחח זה היה מצחיק",
    sender: "נועה",
    expectedIntent: "ignore",
    notes: "Laughing at something — social",
  },
  {
    input: "יאללה ביי",
    sender: "יונתן",
    expectedIntent: "ignore",
    notes: "Goodbye slang",
  },
  {
    input: "שבת שלום",
    sender: "אמא",
    expectedIntent: "ignore",
    notes: "Shabbat greeting",
  },
  {
    input: "חג שמח לכולם!",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "Holiday greeting",
  },
  {
    input: "תודה רבה על הכל",
    sender: "נועה",
    expectedIntent: "ignore",
    notes: "General thanks",
  },
  {
    input: "וואי כמה חם היום",
    sender: "אמא",
    expectedIntent: "ignore",
    notes: "Weather complaint — social",
  },
  {
    input: "מי ראה את המפתחות שלי?",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "Lost keys — immediate question, not a task",
  },
  {
    input: "אוקי",
    sender: "יונתן",
    expectedIntent: "ignore",
    notes: "Simple acknowledgment",
  },
  {
    input: "נו מה קורה",
    sender: "נועה",
    expectedIntent: "ignore",
    notes: "Casual 'what's up'",
  },
  {
    input: "אממ ככה ככה היום היה קשה",
    sender: "אמא",
    expectedIntent: "ignore",
    notes: "Voice-to-text artifact — filler sounds + social sharing",
  },
  {
    input: "🎉🎂🎁 יום הולדת שמח!",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "Birthday wish with emojis",
  },
  {
    input: "Forwarded: check out this article about...",
    sender: "נועה",
    expectedIntent: "ignore",
    notes: "Forwarded content (English)",
  },
  {
    input: "LOL that's hilarious",
    sender: "יונתן",
    expectedIntent: "ignore",
    notes: "English social reaction",
  },
  {
    input: "יא אלוהים איזה גול",
    sender: "אבא",
    expectedIntent: "ignore",
    notes: "Sports reaction — social chatter",
  },
];

// ─── ADD_SHOPPING (20 cases) ───
// Bare nouns, quantities, multi-item, mixed language, corrections

export const ADD_SHOPPING_CASES: TestCase[] = [
  {
    input: "חלב",
    sender: "אמא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "חלב" }] },
    notes: "Bare noun — implicit shopping",
  },
  {
    input: "3 חלב",
    sender: "אבא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "חלב", qty: "3" }] },
    notes: "Quantity + noun",
  },
  {
    input: "עוד חלב",
    sender: "נועה",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "חלב" }] },
    notes: "'More' + noun — add to list",
  },
  {
    input: "חלב, ביצים, לחם",
    sender: "אמא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "חלב" }, { name: "ביצים" }, { name: "לחם" }] },
    notes: "Comma-separated multi-item",
  },
  {
    input: "צריך חלב וביצים",
    sender: "אבא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "חלב" }, { name: "ביצים" }] },
    notes: "Need + items with 'and'",
  },
  {
    input: "צריך לקנות גבינה צהובה ויוגורט",
    sender: "אמא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "גבינה צהובה" }, { name: "יוגורט" }] },
    notes: "Need to buy + compound noun + item",
  },
  {
    input: "אפשר להוסיף קוטג' לרשימה?",
    sender: "נועה",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "קוטג'" }] },
    notes: "Polite request to add to list",
  },
  {
    input: "נגמר לנו אורז",
    sender: "אמא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "אורז" }] },
    notes: "'We ran out of' — implicit shopping",
  },
  {
    input: "need milk",
    sender: "יונתן",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "milk" }] },
    notes: "English shopping request",
  },
  {
    input: "צריך milk ו-bread",
    sender: "יונתן",
    expectedIntent: "add_shopping",
    notes: "Mixed Hebrew/English shopping",
  },
  {
    input: "2 קילו עגבניות",
    sender: "אמא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "עגבניות", qty: "2 קילו" }] },
    notes: "Quantity with unit",
  },
  {
    input: "אין לנו סבון כלים",
    sender: "אבא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "סבון כלים" }] },
    notes: "'We don't have' — implicit shopping",
  },
  {
    input: "🛒 שמנת, קצפת, קקאו",
    sender: "אמא",
    expectedIntent: "add_shopping",
    notes: "Shopping cart emoji + items",
  },
  {
    input: "תוסיפו נייר טואלט",
    sender: "אבא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "נייר טואלט" }] },
    notes: "Imperative 'add' (plural)",
  },
  {
    input: "פירות ירקות",
    sender: "אמא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "פירות" }, { name: "ירקות" }] },
    notes: "Two bare nouns without separator",
  },
  {
    input: "חסר שמן זית ומלח",
    sender: "אמא",
    expectedIntent: "add_shopping",
    notes: "'Missing' — implicit shopping",
  },
  {
    input: "אנחנו צריכים דבר לראש השנה",
    sender: "אמא",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "דבש" }] },
    notes: "Voice-to-text: 'דבר' probably means 'דבש' (honey). Tricky VTT case.",
  },
  {
    input: "pasta and cheese",
    sender: "יונתן",
    expectedIntent: "add_shopping",
    notes: "Full English shopping",
  },
  {
    input: "שוקולד!! הילדים רוצים",
    sender: "נועה",
    expectedIntent: "add_shopping",
    expectedEntities: { items: [{ name: "שוקולד" }] },
    notes: "Emphatic + reason",
  },
  {
    input: "חומוס טחינה פיתות",
    sender: "אבא",
    expectedIntent: "add_shopping",
    notes: "Three items no separators — common Hebrew pattern",
  },
];

// ─── ADD_TASK (20 cases) ───
// Explicit tasks, implicit person+activity+time, chores

export const ADD_TASK_CASES: TestCase[] = [
  {
    input: "צריך לנקות את הבית",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { title: "לנקות את הבית" },
    notes: "Explicit task — 'need to clean'",
  },
  {
    input: "מישהו יכול לשטוף את הרכב?",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { title: "לשטוף את הרכב" },
    notes: "Question as task request",
  },
  {
    input: "נועה חוג 5",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { person: "נועה", title: "חוג", time_raw: "5" },
    notes: "Implicit task: [person] [activity] [time]",
  },
  {
    input: "יונתן צריך הסעה לאימון",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { person: "יונתן", title: "הסעה לאימון" },
    notes: "Person needs ride to practice",
  },
  {
    input: "אבא תוציא את הזבל",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { person: "אבא", title: "להוציא את הזבל" },
    notes: "Direct assignment to member",
  },
  {
    input: "צריך לתקן את הברז במטבח",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { title: "לתקן את הברז במטבח" },
    notes: "Maintenance task",
  },
  {
    input: "מישהו צריך לאסוף את הילדים מהגן ב4",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { title: "לאסוף את הילדים מהגן", time_raw: "ב4" },
    notes: "Pickup task with time",
  },
  {
    input: "חייבים לשלם חשבון חשמל",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { title: "לשלם חשבון חשמל" },
    notes: "'Must' pay electricity bill",
  },
  {
    input: "אל תשכחו לתת לכלב אוכל",
    sender: "נועה",
    expectedIntent: "add_task",
    expectedEntities: { title: "לתת לכלב אוכל" },
    notes: "'Don't forget to' — reminder as task",
  },
  {
    input: "הארון בחדר של נועה נשבר, צריך לתקן",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { title: "לתקן את הארון בחדר של נועה" },
    notes: "Context + task",
  },
  {
    input: "צריך לקבוע תור לווטרינר",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { title: "לקבוע תור לווטרינר" },
    notes: "Appointment scheduling task",
  },
  {
    input: "לגהץ את הבגדים של יונתן לחתונה",
    sender: "אמא",
    expectedIntent: "add_task",
    notes: "Infinitive task — iron clothes for event",
  },
  {
    input: "מישהו יטען את הטאבלט של נועה",
    sender: "אבא",
    expectedIntent: "add_task",
    notes: "Request for someone to charge tablet",
  },
  {
    input: "need to call the plumber",
    sender: "אבא",
    expectedIntent: "add_task",
    notes: "English task",
  },
  {
    input: "יונתן תנקה את החדר שלך",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { person: "יונתן", title: "לנקות את החדר" },
    notes: "Direct command to child",
  },
  {
    input: "אממ צריך לסדר את המרפסת כי ביום שישי באים אורחים",
    sender: "אמא",
    expectedIntent: "add_task",
    notes: "Voice-to-text with filler + reason + time reference",
  },
  {
    input: "לארגן את ארון התרופות",
    sender: "אבא",
    expectedIntent: "add_task",
    notes: "Bare infinitive task",
  },
  {
    input: "להכין ארוחות צהריים לילדים",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { title: "להכין ארוחות צהריים לילדים" },
    notes: "Lunch prep task",
  },
  {
    input: "אבא - הילדים צריכים להגיש טופס לבית ספר",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { person: "אבא" },
    notes: "Addressed to specific member with dash",
  },
  {
    input: "אי אפשר לשכוח לחדש ביטוח רכב",
    sender: "אבא",
    expectedIntent: "add_task",
    notes: "Can't forget — urgent task phrasing",
  },
  // ─── Rotation patterns ───
  {
    input: "תורות מקלחת: דניאל ראשון, נועה, יובל",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "מקלחת", type: "order", members: ["דניאל", "נועה", "יובל"] } },
    notes: "Order rotation — shower turns for 3 kids",
  },
  {
    input: "תורנות כלים: נועה, יובל, דניאל",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "כלים", type: "duty", members: ["נועה", "יובל", "דניאל"] } },
    notes: "Duty rotation — dishes chore",
  },
  {
    input: "סדר מקלחות: נועה, יובל, דניאל",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "מקלחת", type: "order", members: ["נועה", "יובל", "דניאל"] } },
    notes: "Order rotation — alternative phrasing with סדר",
  },
  {
    input: "מי בתור למקלחת?",
    sender: "נועה",
    expectedIntent: "question",
    notes: "'Whose turn' is a question about rotation, not a task",
  },
  {
    input: "היום יובל שוטף כלים",
    sender: "אמא",
    expectedIntent: "add_task",
    notes: "Override — specific person for today's duty (when rotation exists)",
  },
  {
    input: "כל יום שני ורביעי תורנות כביסה: דניאל, נועה",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { rotation: { title: "כביסה", type: "duty", members: ["דניאל", "נועה"] } },
    notes: "Duty rotation with weekly frequency",
  },
  // ─── Override patterns ───
  {
    input: "היום גילעד בתורות למקלחת",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { override: { title: "מקלחת", person: "גילעד" } },
    notes: "Override rotation — specific person for today (when rotation exists)",
  },
  {
    input: "אביב תורן כלים היום",
    sender: "אבא",
    expectedIntent: "add_task",
    expectedEntities: { override: { title: "כלים", person: "אביב" } },
    notes: "Override using תורן synonym",
  },
  {
    input: "גילעד ראשון במקלחת היום",
    sender: "אמא",
    expectedIntent: "add_task",
    expectedEntities: { override: { title: "מקלחת", person: "גילעד" } },
    notes: "Override — first in shower today",
  },
];

// ─── INSTRUCT_BOT (4 cases) ───
// Parent explaining rules/management preferences to Sheli

export const INSTRUCT_BOT_CASES: TestCase[] = [
  {
    input: "ככה יום אביב יום גילעד",
    sender: "אמא",
    expectedIntent: "instruct_bot",
    notes: "Explaining alternating daily pattern",
  },
  {
    input: "אבל את אמורה לנהל את התורות- אמרתי שזה תור יומי פעם אביב ופעם גילעד והיום גילעד",
    sender: "אמא",
    expectedIntent: "instruct_bot",
    notes: "Frustrated re-explanation of rotation rule",
  },
  {
    input: "צריך לנהל את הכלים ככה שכל יום ילד אחר",
    sender: "אבא",
    expectedIntent: "instruct_bot",
    notes: "Teaching daily chore rotation pattern",
  },
  {
    input: "את אמורה לזכור מי בתור ולהחליף כל יום",
    sender: "אמא",
    expectedIntent: "instruct_bot",
    notes: "Explaining expected bot behavior",
  },
];

// ─── ADD_EVENT (15 cases) ───
// Time expressions, relative dates, Hebrew days

export const ADD_EVENT_CASES: TestCase[] = [
  {
    input: "יום שלישי ארוחת ערב אצל סבתא",
    sender: "אמא",
    expectedIntent: "add_event",
    expectedEntities: { title: "ארוחת ערב אצל סבתא", time_raw: "יום שלישי" },
    notes: "Hebrew day + event",
  },
  {
    input: "מחר ב10 יש אסיפת הורים",
    sender: "אבא",
    expectedIntent: "add_event",
    expectedEntities: { title: "אסיפת הורים", time_raw: "מחר ב10" },
    notes: "Tomorrow + time",
  },
  {
    input: "רופא שיניים ליונתן ביום חמישי בשעה 3",
    sender: "אמא",
    expectedIntent: "add_event",
    expectedEntities: { person: "יונתן", title: "רופא שיניים", time_raw: "יום חמישי בשעה 3" },
    notes: "Appointment with person and full date",
  },
  {
    input: "יש meeting ב-3",
    sender: "אבא",
    expectedIntent: "add_event",
    expectedEntities: { title: "meeting", time_raw: "ב-3" },
    notes: "Mixed Hebrew/English event",
  },
  {
    input: "חתונה של דודה מירי ביום שישי",
    sender: "אמא",
    expectedIntent: "add_event",
    expectedEntities: { title: "חתונה של דודה מירי", time_raw: "יום שישי" },
    notes: "Family event on Friday",
  },
  {
    input: "שיעור פסנתר של נועה ביום ראשון 16:00",
    sender: "אמא",
    expectedIntent: "add_event",
    expectedEntities: { person: "נועה", title: "שיעור פסנתר", time_raw: "יום ראשון 16:00" },
    notes: "Recurring lesson — new event instance",
  },
  {
    input: "אחרי הצהריים יש אימון כדורגל ליונתן",
    sender: "אבא",
    expectedIntent: "add_event",
    expectedEntities: { person: "יונתן", title: "אימון כדורגל", time_raw: "אחרי הצהריים" },
    notes: "Vague time expression",
  },
  {
    input: "ראש השנה אצל ההורים",
    sender: "אמא",
    expectedIntent: "add_event",
    notes: "Holiday event — no specific time",
  },
  {
    input: "zoom call עם הסבתא ביום רביעי ב7 בערב",
    sender: "נועה",
    expectedIntent: "add_event",
    notes: "Mixed language event with evening time",
  },
  {
    input: "הזמנו שולחן למסעדה ליום שבת ב-8",
    sender: "אבא",
    expectedIntent: "add_event",
    expectedEntities: { title: "מסעדה", time_raw: "שבת ב-8" },
    notes: "Restaurant reservation",
  },
  {
    input: "Birthday party for Noa next Sunday at 4",
    sender: "אמא",
    expectedIntent: "add_event",
    notes: "English event with relative date",
  },
  {
    input: "הפגישה עם המורה נדחתה ליום שני",
    sender: "אמא",
    expectedIntent: "add_event",
    notes: "Rescheduled meeting — update event",
  },
  {
    input: "לפני שבת צריך להגיע לסבא",
    sender: "אמא",
    expectedIntent: "add_event",
    expectedEntities: { time_raw: "לפני שבת" },
    notes: "'Before Shabbat' — Friday afternoon",
  },
  {
    input: "הצגה של נועה בבית ספר ביום רביעי ב11",
    sender: "אמא",
    expectedIntent: "add_event",
    expectedEntities: { person: "נועה", time_raw: "יום רביעי ב11" },
    notes: "School performance event",
  },
  {
    input: "דוקטור אצל דר גולדברג ב14 ביום חמישי",
    sender: "אבא",
    expectedIntent: "add_event",
    notes: "Doctor appointment with specific time",
  },
];

// ─── COMPLETE_TASK (10 cases) ───
// Explicit completions, implicit confirmations

export const COMPLETE_TASK_CASES: TestCase[] = [
  {
    input: "שטפתי את הכלים",
    sender: "אבא",
    expectedIntent: "complete_task",
    expectedEntities: { task_id: "t1a2" },
    notes: "Past tense of open task 'לשטוף כלים'",
  },
  {
    input: "הכלים מוכנים",
    sender: "אבא",
    expectedIntent: "complete_task",
    expectedEntities: { task_id: "t1a2" },
    notes: "Implicit completion — 'dishes are done'",
  },
  {
    input: "סיימתי עם הארון",
    sender: "נועה",
    expectedIntent: "complete_task",
    expectedEntities: { task_id: "t5c6" },
    notes: "Finished organizing closet",
  },
  {
    input: "קבעתי תור לרופא שיניים",
    sender: "אמא",
    expectedIntent: "complete_task",
    expectedEntities: { task_id: "t3b4" },
    notes: "Completed appointment scheduling task",
  },
  {
    input: "done with the dishes",
    sender: "אבא",
    expectedIntent: "complete_task",
    notes: "English completion",
  },
  {
    input: "עשיתי את זה ✅",
    sender: "נועה",
    expectedIntent: "complete_task",
    notes: "Generic 'did it' with checkmark — needs context",
  },
  {
    input: "המתנה לסבתא מוכנה",
    sender: "אמא",
    expectedIntent: "complete_task",
    expectedEntities: { task_id: "t7d8" },
    notes: "Gift is ready — matches 'לקנות מתנה לסבתא'",
  },
  {
    input: "בוצע",
    sender: "אבא",
    expectedIntent: "complete_task",
    notes: "'Done' — generic completion, needs task context",
  },
  {
    input: "טיפלתי בזה",
    sender: "אמא",
    expectedIntent: "complete_task",
    notes: "'Handled it' — generic completion",
  },
  {
    input: "סידרתי את הארון של נועה",
    sender: "נועה",
    expectedIntent: "complete_task",
    expectedEntities: { task_id: "t5c6" },
    notes: "Explicit match to 'לסדר את הארון'",
  },
];

// ─── COMPLETE_SHOPPING (10 cases) ───
// Bought items, at-store confirmations

export const COMPLETE_SHOPPING_CASES: TestCase[] = [
  {
    input: "קניתי חלב",
    sender: "אמא",
    expectedIntent: "complete_shopping",
    expectedEntities: { item_id: "s1a2" },
    notes: "Bought milk — matches 'חלב' on list",
  },
  {
    input: "יש חלב",
    sender: "אבא",
    expectedIntent: "complete_shopping",
    expectedEntities: { item_id: "s1a2" },
    notes: "'Have milk' — implies got it",
  },
  {
    input: "לקחתי ביצים ולחם",
    sender: "אמא",
    expectedIntent: "complete_shopping",
    notes: "Took eggs and bread — two items completed",
  },
  {
    input: "הלחם בבית",
    sender: "אבא",
    expectedIntent: "complete_shopping",
    expectedEntities: { item_id: "s5c6" },
    notes: "'Bread is home' — implies purchased",
  },
  {
    input: "got the eggs",
    sender: "יונתן",
    expectedIntent: "complete_shopping",
    notes: "English confirmation",
  },
  {
    input: "מצאתי אבקת כביסה במבצע ולקחתי",
    sender: "אמא",
    expectedIntent: "complete_shopping",
    expectedEntities: { item_id: "s7d8" },
    notes: "Found on sale — implies bought",
  },
  {
    input: "✅ חלב ביצים לחם",
    sender: "אמא",
    expectedIntent: "complete_shopping",
    notes: "Checkmark + items list = all done",
  },
  {
    input: "אני בסופר, לקחתי את הכל",
    sender: "אבא",
    expectedIntent: "complete_shopping",
    notes: "At the store, got everything",
  },
  {
    input: "הביצים אצלי",
    sender: "אמא",
    expectedIntent: "complete_shopping",
    expectedEntities: { item_id: "s3b4" },
    notes: "'Eggs are with me' — implies got them",
  },
  {
    input: "חלב וביצים ✓",
    sender: "אבא",
    expectedIntent: "complete_shopping",
    notes: "Items with checkmark",
  },
];

// ─── QUESTION (10 cases) ───
// Queries about household state — reply, no DB write

export const QUESTION_CASES: TestCase[] = [
  {
    input: "מי אוסף היום?",
    sender: "אמא",
    expectedIntent: "question",
    notes: "Who's picking up today? — schedule query",
  },
  {
    input: "מה צריך מהסופר?",
    sender: "אבא",
    expectedIntent: "question",
    notes: "Shopping list query",
  },
  {
    input: "מה נשאר לעשות?",
    sender: "נועה",
    expectedIntent: "question",
    notes: "Open tasks query",
  },
  {
    input: "מתי הרופא של יונתן?",
    sender: "אמא",
    expectedIntent: "question",
    notes: "Event schedule query",
  },
  {
    input: "מישהו יודע מה יש היום?",
    sender: "אבא",
    expectedIntent: "question",
    notes: "Today's schedule query",
  },
  {
    input: "what's on the list?",
    sender: "יונתן",
    expectedIntent: "question",
    notes: "English shopping list query",
  },
  {
    input: "כמה משימות פתוחות יש?",
    sender: "נועה",
    expectedIntent: "question",
    notes: "Task count query",
  },
  {
    input: "מה התוכניות למחר?",
    sender: "אמא",
    expectedIntent: "question",
    notes: "Tomorrow's plans query",
  },
  {
    input: "יש משהו דחוף?",
    sender: "אבא",
    expectedIntent: "question",
    notes: "Urgency check query",
  },
  {
    input: "מי אמור לעשות את הכביסה?",
    sender: "נועה",
    expectedIntent: "question",
    notes: "Task assignment query",
  },
];

// ─── CLAIM_TASK (5 cases) ───
// Self-assignment to existing tasks

export const CLAIM_TASK_CASES: TestCase[] = [
  {
    input: "אני אשטוף כלים",
    sender: "אבא",
    expectedIntent: "claim_task",
    expectedEntities: { person: "אבא", task_id: "t1a2" },
    notes: "I'll wash dishes — matches open task",
  },
  {
    input: "אני לוקחת את התור לרופא",
    sender: "אמא",
    expectedIntent: "claim_task",
    expectedEntities: { person: "אמא", task_id: "t3b4" },
    notes: "Feminine 'I'll take' — matches task",
  },
  {
    input: "אני אעשה את זה",
    sender: "נועה",
    expectedIntent: "claim_task",
    notes: "Generic 'I'll do it' — needs recent context",
  },
  {
    input: "אני יכול לטפל במתנה",
    sender: "אבא",
    expectedIntent: "claim_task",
    expectedEntities: { person: "אבא", task_id: "t7d8" },
    notes: "I can handle the gift — matches 'לקנות מתנה לסבתא'",
  },
  {
    input: "I'll handle the dentist appointment",
    sender: "אמא",
    expectedIntent: "claim_task",
    expectedEntities: { task_id: "t3b4" },
    notes: "English claim — matches dentist task",
  },
];

// ─── INFO_REQUEST (5 cases) ───
// NOT tasks — requests for info or non-household actions

export const INFO_REQUEST_CASES: TestCase[] = [
  {
    input: "מה הסיסמא של הוויי פיי?",
    sender: "נועה",
    expectedIntent: "info_request",
    notes: "WiFi password — NOT a task",
  },
  {
    input: "שלח לי את הקוד",
    sender: "יונתן",
    expectedIntent: "info_request",
    notes: "Send me the code — request for info, not household task",
  },
  {
    input: "כמה עולה חוג כדורגל?",
    sender: "אבא",
    expectedIntent: "info_request",
    notes: "Cost question — information, not task",
  },
  {
    input: "מה מספר הטלפון של הרופא?",
    sender: "אמא",
    expectedIntent: "info_request",
    notes: "Phone number query — not a task",
  },
  {
    input: "where is the remote control?",
    sender: "יונתן",
    expectedIntent: "info_request",
    notes: "English info request — lost item",
  },
];

// ─── ALL CASES combined ───

export const ALL_CASES: TestCase[] = [
  ...IGNORE_CASES,
  ...ADD_SHOPPING_CASES,
  ...ADD_TASK_CASES,
  ...INSTRUCT_BOT_CASES,
  ...ADD_EVENT_CASES,
  ...COMPLETE_TASK_CASES,
  ...COMPLETE_SHOPPING_CASES,
  ...QUESTION_CASES,
  ...CLAIM_TASK_CASES,
  ...INFO_REQUEST_CASES,
];

export const CASE_COUNTS: Record<string, number> = {
  ignore: IGNORE_CASES.length,
  add_shopping: ADD_SHOPPING_CASES.length,
  add_task: ADD_TASK_CASES.length,
  instruct_bot: INSTRUCT_BOT_CASES.length,
  add_event: ADD_EVENT_CASES.length,
  complete_task: COMPLETE_TASK_CASES.length,
  complete_shopping: COMPLETE_SHOPPING_CASES.length,
  question: QUESTION_CASES.length,
  claim_task: CLAIM_TASK_CASES.length,
  info_request: INFO_REQUEST_CASES.length,
};

console.log(`Total test cases: ${ALL_CASES.length}`);
console.log("Distribution:", CASE_COUNTS);
