// Haiku Intent Classifier — Stage 1 of two-stage pipeline
// Fast, cheap classification of Hebrew family WhatsApp messages
// Returns: { intent, confidence, entities } — NO reply generation

export interface ClassificationOutput {
  intent:
    | "add_task"
    | "add_shopping"
    | "add_event"
    | "complete_task"
    | "complete_shopping"
    | "ignore"
    | "question"
    | "claim_task"
    | "info_request"
    | "correct_bot"
    | "add_reminder"
    | "instruct_bot"
    | "save_memory"
    | "recall_memory"
    | "delete_memory";
  confidence: number; // 0.0 - 1.0
  addressed_to_bot?: boolean; // true when user is talking TO Sheli
  needs_conversation_review?: boolean; // true when context makes intent ambiguous
  entities: {
    person?: string;
    items?: Array<{ name: string; qty?: string; category?: string }>;
    rotation?: {
      title: string;
      type: "order" | "duty";
      members: string[];
      frequency?: { type: "daily" } | { type: "interval"; days: number } | { type: "weekly"; days: string[] };
    };
    override?: {
      title: string;
      person: string;
    };
    title?: string;
    time_raw?: string;
    time_iso?: string;
    task_id?: string;
    item_id?: string;
    correction_text?: string;
    reminder_text?: string;
    memory_content?: string;
    memory_about?: string; // member name
    raw_text: string;
  };
}

export interface ClassifierContext {
  members: string[];
  openTasks: Array<{ id: string; title: string; assigned_to: string | null }>;
  openShopping: Array<{ id: string; name: string; qty: string | null }>;
  today: string; // ISO date "2026-04-02"
  dayOfWeek: string; // Hebrew day name "רביעי"
  familyPatterns?: string; // Learned patterns for this household
  conversationHistory?: string; // Formatted recent conversation for context
}

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

function buildClassifierPrompt(ctx: ClassifierContext): string {
  const tasksStr =
    ctx.openTasks.length === 0
      ? "(none)"
      : ctx.openTasks
          .map(
            (t) =>
              `• ${t.title}${t.assigned_to ? ` → ${t.assigned_to}` : ""} (id:${t.id})`
          )
          .join("\n");

  const shoppingStr =
    ctx.openShopping.length === 0
      ? "(empty)"
      : ctx.openShopping
          .map((s) => `• ${s.name}${s.qty ? ` ×${s.qty}` : ""} (id:${s.id})`)
          .join("\n");

  const hebrewDays = [
    "ראשון",
    "שני",
    "שלישי",
    "רביעי",
    "חמישי",
    "שישי",
    "שבת",
  ];
  const upcomingDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(ctx.today);
    d.setDate(d.getDate() + i);
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${hebrewDays[d.getDay()]} = ${iso}${i === 0 ? " (today)" : ""}`;
  }).join(", ");

  return `You are a Hebrew family WhatsApp message classifier. Classify each message into exactly ONE intent.

INTENTS:
- ignore: Social noise (greetings, reactions, emojis, jokes, chatter, forwarded messages, status updates). ~80% of messages.
- add_shopping: Adding item(s) to shopping list. Bare nouns, "צריך X", "נגמר X", "אין X".
- add_task: Creating a household chore/to-do. "צריך ל...", "[person] [activity] [time]", maintenance requests.
- add_event: Scheduling a specific date/time event. Appointments, classes, dinners, meetings.
- complete_task: Marking an existing task as done. Past tense of open task, "סיימתי", "בוצע".
- complete_shopping: Confirming purchase of a list item. "קניתי", "יש", "לקחתי".
- question: Asking about household state (tasks, schedule, list). "מה צריך?", "מי אוסף?", "מה יש היום?".
- claim_task: Self-assigning an existing open task. "אני אעשה", "אני לוקח/ת", "אני יכול".
- info_request: Asking for information that is NOT a household task. Passwords, phone numbers, prices, codes.
- correct_bot: Correcting something Sheli just did wrong. "התכוונתי ל...", "לא X, כן Y", "תתקני", "טעית", "זה פריט אחד".

MEMBERS: ${ctx.members.join(", ")}
TODAY: ${ctx.today} (${ctx.dayOfWeek})
UPCOMING: ${upcomingDays}

OPEN TASKS:
${tasksStr}

SHOPPING LIST:
${shoppingStr}

HEBREW PATTERNS:
- Bare noun ("חלב") = add_shopping
- "[person] [activity] [time]" ("נועה חוג 5") = add_task
- "מי [verb]?" = question (not add_task)
- "אני [verb]" matching an open task = claim_task
- Past tense matching open task ("שטפתי כלים") = complete_task
- "קניתי X" / "יש X" matching shopping item = complete_shopping
- Greetings, emojis, reactions, "סבבה", "אמן", "בהצלחה" = ignore
- "מה הסיסמא?", "שלח קוד" = info_request (NOT add_task)
- Hebrew time: "ב5" = 17:00, "בצהריים" = ~12:00, "אחרי הגן" = ~16:00, "לפני שבת" = Friday PM
- "תור/תורות" (turns), "סדר" (order), "סבב/תורנות" (duty rotation) = add_task with rotation entity
- ROTATION DETECTION: when message names an activity + multiple people in sequence, create a rotation:
  - Ordering activities (מקלחת, אמבטיה, shower) → type "order" (who goes first, advances daily)
  - Chore activities (כלים, כביסה, זבל, ניקיון, dishes, laundry, trash) → type "duty" (whose job, advances on completion)
  - When ambiguous, default to "duty"
- "מי בתור ל...?" = question (about existing rotation)

${ctx.familyPatterns ? `FAMILY PATTERNS (learned for this household):\n${ctx.familyPatterns}\n` : ""}${ctx.conversationHistory ? `
RECENT CONVERSATION (oldest first, for context):
${ctx.conversationHistory}

CONVERSATION CONTEXT RULES:
- Read the RECENT CONVERSATION to understand the CURRENT MESSAGE in context.
- A message that REFERS to a previously mentioned product/task/event is NOT a new request.
  Example: "אין ספרייט" after someone asked for Sprite = status update → ignore.
- A message correcting/updating a previous request is NOT a new add.
  Example: "לא 2, צריך 3" = quantity update on most recent item, not new item.
- A message between family members ABOUT an item is social chatter → ignore.
  Example: "גור יש רק 7אפ" = telling Gur something, not requesting the bot.
- Only classify as actionable when the sender is clearly REQUESTING the bot to act.
- These rules apply to ALL entity types: shopping, tasks, and events.
- If you are uncertain whether a message is a request or just conversation, set confidence: 0.55 and needs_conversation_review: true.
` : ""}HEBREW DAYS: ראשון=Sunday, שני=Monday, שלישי=Tuesday, רביעי=Wednesday, חמישי=Thursday, שישי=Friday, שבת=Saturday

EXAMPLES:
[אמא]: "בוקר טוב!" → {"intent":"ignore","confidence":0.99,"entities":{"raw_text":"בוקר טוב!"}}
[אבא]: "חלב" → {"intent":"add_shopping","confidence":0.95,"entities":{"items":[{"name":"חלב"}],"raw_text":"חלב"}}
[אמא]: "נועה חוג 5" → {"intent":"add_task","confidence":0.90,"entities":{"person":"נועה","title":"חוג","time_raw":"5","raw_text":"נועה חוג 5"}}
[אבא]: "שטפתי את הכלים" → {"intent":"complete_task","confidence":0.95,"entities":{"task_id":"t1a2","raw_text":"שטפתי את הכלים"}}
[אמא]: "מה צריך מהסופר?" → {"intent":"question","confidence":0.95,"entities":{"raw_text":"מה צריך מהסופר?"}}
[נועה]: "אני אסדר את הארון" → {"intent":"claim_task","confidence":0.90,"entities":{"person":"נועה","task_id":"t5c6","raw_text":"אני אסדר את הארון"}}
[אמא]: "יום שלישי ארוחת ערב אצל סבתא" → {"intent":"add_event","confidence":0.92,"entities":{"title":"ארוחת ערב אצל סבתא","time_raw":"יום שלישי","raw_text":"יום שלישי ארוחת ערב אצל סבתא"}}
[יונתן]: "מה הסיסמא של הוויי פיי?" → {"intent":"info_request","confidence":0.95,"entities":{"raw_text":"מה הסיסמא של הוויי פיי?"}}
[אמא]: "קניתי חלב וביצים" → {"intent":"complete_shopping","confidence":0.95,"entities":{"item_id":"s1a2","raw_text":"קניתי חלב וביצים"}}
[אמא]: "התכוונתי לשמן זית, לא לשמן וזית" → {"intent":"correct_bot","confidence":0.95,"entities":{"correction_text":"שמן זית","raw_text":"התכוונתי לשמן זית, לא לשמן וזית"}}
[אבא]: "שלי טעית, זה דבר אחד" → {"intent":"correct_bot","confidence":0.90,"entities":{"correction_text":"","raw_text":"שלי טעית, זה דבר אחד"}}
[אמא]: "תורות מקלחת: דניאל ראשון, נועה, יובל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["דניאל","נועה","יובל"]},"raw_text":"תורות מקלחת: דניאל ראשון, נועה, יובל"}}
[אבא]: "תורנות כלים: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"כלים","type":"duty","members":["נועה","יובל","דניאל"]},"raw_text":"תורנות כלים: נועה, יובל, דניאל"}}
[אמא]: "סדר מקלחות: נועה, יובל, דניאל" → {"intent":"add_task","confidence":0.92,"entities":{"rotation":{"title":"מקלחת","type":"order","members":["נועה","יובל","דניאל"]},"raw_text":"סדר מקלחות: נועה, יובל, דניאל"}}
[אבא]: "מי בתור למקלחת?" → {"intent":"question","confidence":0.90,"entities":{"raw_text":"מי בתור למקלחת?"}}

RULES:
- Respond with ONLY a JSON object. No other text, no markdown.
- Always include raw_text in entities.
- For complete_task/complete_shopping/claim_task: match against open tasks/shopping IDs above.
- For add_event: include time_raw (Hebrew expression) and time_iso (ISO 8601 with +03:00) if resolvable.
- For add_shopping: extract individual items into the items array.
- For add_task with ROTATION (turns/duty for multiple people): include "rotation" object with title, type ("order"|"duty"), members array (preserve order), and optional frequency. Do NOT use title/person fields when rotation is present.
- Confidence: 0.95+ for clear cases, 0.70-0.90 for moderate, 0.50-0.69 for ambiguous.
- When unsure between action and ignore, prefer ignore (false silence > false action).
- For correct_bot: extract what the user MEANT in correction_text. This is about fixing Sheli's last action.
- If conversation context makes your classification uncertain, include "needs_conversation_review": true in your response.`;
}

export async function classifyIntent(
  message: string,
  sender: string,
  context: ClassifierContext,
  apiKey?: string
): Promise<ClassificationOutput> {
  const key = apiKey || Deno.env.get("ANTHROPIC_API_KEY") || "";
  const systemPrompt = buildClassifierPrompt(context);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: `[${sender}]: ${message}` }],
      }),
    });

    if (!res.ok) {
      console.error(
        "[HaikuClassifier] API error:",
        res.status,
        await res.text()
      );
      return fallbackIgnore(message);
    }

    const data = await res.json();
    const raw = (data.content?.[0]?.text || "{}")
      .replace(/```json\n?|```/g, "")
      .trim();

    try {
      const parsed = JSON.parse(raw);
      return {
        intent: parsed.intent || "ignore",
        confidence:
          typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        addressed_to_bot: parsed.addressed_to_bot || false,
        needs_conversation_review: parsed.needs_conversation_review || false,
        entities: {
          ...parsed.entities,
          raw_text: message,
        },
      };
    } catch {
      console.error("[HaikuClassifier] JSON parse error:", raw);
      return fallbackIgnore(message);
    }
  } catch (err) {
    console.error("[HaikuClassifier] Fetch error:", err);
    return fallbackIgnore(message);
  }
}

function fallbackIgnore(message: string): ClassificationOutput {
  return {
    intent: "ignore",
    confidence: 0.75,  // Was 0.0 — caused unnecessary Sonnet escalations. 0.75 routes through ignore path.
    entities: { raw_text: message },
  };
}

// Re-export for backward compatibility during migration
export type { ClassifierContext as HaikuClassifierContext };

/**
 * Fetch recent conversation for context injection.
 * Returns whichever is MORE: all messages within 15 min, OR last 10 regardless of age.
 * Capped at 30 messages, returned in chronological order.
 */
export async function fetchRecentConversation(
  supabase: any,
  groupId: string,
  excludeMessageId?: string
): Promise<Array<{ sender_name: string; message_text: string; created_at: string }>> {
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  // Query 1: all messages within 15 minutes
  const { data: recentByTime } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at")
    .eq("group_id", groupId)
    .gte("created_at", fifteenMinAgo)
    .order("created_at", { ascending: true })
    .limit(30);

  // Query 2: last 10 messages regardless of age
  const { data: recentByCount } = await supabase
    .from("whatsapp_messages")
    .select("id, sender_name, message_text, created_at")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(10);

  // Merge: use whichever set is LARGER, then add unique messages from the other
  const byTime = recentByTime || [];
  const byCount = (recentByCount || []).reverse(); // chronological
  const base = byTime.length >= byCount.length ? byTime : byCount;

  // Merge any messages from the other set not already included
  const ids = new Set(base.map((m: any) => m.id));
  const other = byTime.length >= byCount.length ? byCount : byTime;
  for (const m of other) {
    if (!ids.has(m.id)) {
      base.push(m);
      ids.add(m.id);
    }
  }

  // Sort chronologically, exclude current message, cap at 30
  return base
    .filter((m: any) => m.id !== excludeMessageId && m.message_text)
    .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at))
    .slice(-30)
    .map((m: any) => ({
      sender_name: m.sender_name || "?",
      message_text: m.message_text,
      created_at: m.created_at,
    }));
}
