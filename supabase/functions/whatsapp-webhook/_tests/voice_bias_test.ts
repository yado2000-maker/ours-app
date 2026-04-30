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

function stubFetch(memberRows: Array<{ member_name: string }>, itemRows: Array<{ name: string }>) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("whatsapp_member_mapping")) {
      return new Response(JSON.stringify(memberRows), { status: 200 });
    }
    if (url.includes("shopping_items")) {
      return new Response(JSON.stringify(itemRows), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };
  return () => { globalThis.fetch = orig; };
}

Deno.test("buildVoicePromptBias returns Hebrew-comma-joined names + items", async () => {
  const restore = stubFetch(
    [{ member_name: "אביטל" }, { member_name: "ירון" }, { member_name: "נעם" }],
    [{ name: "חלב" }, { name: "פיתות" }],
  );
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
  const restore = stubFetch([], []);
  try {
    const bias = await buildVoicePromptBias("hh_empty");
    assertEquals(bias, "");
  } finally {
    restore();
  }
});

Deno.test("buildVoicePromptBias caps at 600 chars (Whisper 224-token limit)", async () => {
  const manyMembers = Array.from({ length: 50 }, (_, i) => ({ member_name: `שם${i}` }));
  const restore = stubFetch(manyMembers, []);
  try {
    const bias = await buildVoicePromptBias("hh_big");
    assertEquals(bias.length <= 600, true);
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
