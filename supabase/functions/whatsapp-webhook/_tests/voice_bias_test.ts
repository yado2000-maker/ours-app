// supabase/functions/whatsapp-webhook/_tests/voice_bias_test.ts
//
// Run from repo root:
//   SUPABASE_URL=stub SUPABASE_SERVICE_ROLE_KEY=stub deno test \
//     --no-lock --no-check --node-modules-dir=auto --allow-net --allow-env \
//     supabase/functions/whatsapp-webhook/_tests/voice_bias_test.ts
//
// The flag stack is needed because importing `index.inlined.ts` triggers
// top-level `Deno.serve` and a real `createClient` call. Tests stub
// `globalThis.fetch` to isolate `buildVoicePromptBias` from the network.
import { assertEquals } from "jsr:@std/assert@1";
import { buildVoicePromptBias } from "../index.inlined.ts";

type StubData = {
  members?: Array<{ member_name: string }>;
  items?: Array<{ name: string }>;
  tasks?: Array<{ title: string }>;
  events?: Array<{ title: string }>;
};

function stubFetch(data: StubData) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    // Order matters: check the more-specific table names first so e.g.
    // `shopping_items` doesn't get matched by a future `items`-substring rule.
    if (url.includes("whatsapp_member_mapping")) {
      return new Response(JSON.stringify(data.members ?? []), { status: 200 });
    }
    if (url.includes("shopping_items")) {
      return new Response(JSON.stringify(data.items ?? []), { status: 200 });
    }
    if (url.includes("/rest/v1/tasks")) {
      return new Response(JSON.stringify(data.tasks ?? []), { status: 200 });
    }
    if (url.includes("/rest/v1/events")) {
      return new Response(JSON.stringify(data.events ?? []), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };
  return () => { globalThis.fetch = orig; };
}

Deno.test("buildVoicePromptBias returns Hebrew-comma-joined names + items", async () => {
  const restore = stubFetch({
    members: [{ member_name: "אביטל" }, { member_name: "ירון" }, { member_name: "נעם" }],
    items: [{ name: "חלב" }, { name: "פיתות" }],
  });
  try {
    const bias = await buildVoicePromptBias("hh_test");
    assertEquals(bias.includes("אביטל"), true);
    assertEquals(bias.includes("ירון"), true);
    assertEquals(bias.includes("נעם"), true);
    assertEquals(bias.includes("חלב"), true);
    assertEquals(bias.includes("פיתות"), true);
    assertEquals(bias.split(",").length >= 5, true);
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias returns empty string when household has no members", async () => {
  const restore = stubFetch({ members: [], items: [] });
  try {
    const bias = await buildVoicePromptBias("hh_empty");
    assertEquals(bias, "");
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias caps at 800 UTF-8 bytes (Groq's 896-byte Whisper prompt limit)", async () => {
  const manyMembers = Array.from({ length: 50 }, (_, i) => ({ member_name: `שם${i}` }));
  const restore = stubFetch({ members: manyMembers, items: [] });
  try {
    const bias = await buildVoicePromptBias("hh_big");
    const byteLen = new TextEncoder().encode(bias).length;
    assertEquals(byteLen <= 800, true);
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias respects 800-byte UTF-8 cap (Hebrew is 2 bytes per char)", async () => {
  // 50 Hebrew names averaging 10 chars (20 bytes) each = 1000 bytes total raw,
  // way over Groq's 896-byte limit. Helper must trim to ≤800 bytes.
  const restore = stubFetch({
    members: Array.from({ length: 50 }, (_, i) => ({ member_name: `שםארוךמאד${i}` })),
    items: [],
    tasks: [],
    events: [],
  });
  try {
    const bias = await buildVoicePromptBias("hh_test_bytes");
    const byteLen = new TextEncoder().encode(bias).length;
    console.log(`[test] byte cap test produced bias of ${byteLen} bytes (${bias.length} chars)`);
    assertEquals(byteLen <= 800, true, `bias byte length ${byteLen} exceeds 800-byte cap`);
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias still includes content when within byte cap", async () => {
  const restore = stubFetch({
    members: [{ member_name: "אביטל" }, { member_name: "גיורא" }],
    items: [{ name: "חלב" }],
    tasks: [{ title: "להתקשר" }],
    events: [],
  });
  try {
    const bias = await buildVoicePromptBias("hh_small");
    assertEquals(bias.includes("אביטל"), true);
    assertEquals(bias.includes("גיורא"), true);
    assertEquals(bias.includes("חלב"), true);
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias returns empty string for null/undefined household", async () => {
  const bias1 = await buildVoicePromptBias(null);
  const bias2 = await buildVoicePromptBias(undefined);
  assertEquals(bias1, "");
  assertEquals(bias2, "");
});

Deno.test("buildVoicePromptBias includes recent task titles", async () => {
  const restore = stubFetch({
    members: [{ member_name: "Yaron" }],
    items: [],
    tasks: [{ title: "להתקשר לאביטל האדריכלית" }],
    events: [],
  });
  try {
    const bias = await buildVoicePromptBias("hh_test");
    assertEquals(bias.includes("אביטל"), true);
    assertEquals(bias.includes("האדריכלית"), true);
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias includes recent event titles", async () => {
  const restore = stubFetch({
    members: [{ member_name: "Yaron" }],
    items: [],
    tasks: [],
    events: [{ title: "פגישה עם גיורא" }],
  });
  try {
    const bias = await buildVoicePromptBias("hh_test");
    assertEquals(bias.includes("גיורא"), true);
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias prioritizes members > tasks > events > items under cap", async () => {
  // 50 of each — cap should keep names first, items last.
  const make = (prefix: string) => Array.from({ length: 50 }, (_, i) => `${prefix}${i}`);
  const restore = stubFetch({
    members: make("M").map((m) => ({ member_name: m })),
    items: make("I").map((n) => ({ name: n })),
    tasks: make("T").map((t) => ({ title: t })),
    events: make("E").map((t) => ({ title: t })),
  });
  try {
    const bias = await buildVoicePromptBias("hh_big");
    assertEquals(new TextEncoder().encode(bias).length <= 800, true);
    // First member must appear; last shopping item likely won't.
    assertEquals(bias.includes("M0"), true);
    assertEquals(bias.includes("I49"), false);
  } finally {
    restore();
  }
});
