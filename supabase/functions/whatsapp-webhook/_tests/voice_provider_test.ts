// supabase/functions/whatsapp-webhook/_tests/voice_provider_test.ts
//
// Run from repo root:
//   SUPABASE_URL=stub SUPABASE_SERVICE_ROLE_KEY=stub deno test \
//     --no-lock --no-check --node-modules-dir=auto --allow-net --allow-env \
//     supabase/functions/whatsapp-webhook/_tests/voice_provider_test.ts
//
// Stubs `globalThis.fetch` to mock both Groq and ivrit-ai HF responses,
// then asserts that `transcribeVoice` routes to the right provider based
// on the VOICE_PROVIDER env var. Default = groq for instant rollback.
import { assertEquals } from "jsr:@std/assert@1";
import {
  parseCompareWhitelist,
  transcribeVoice,
  transcribeVoiceCompare,
  transcribeVoiceGroq,
  transcribeVoiceIvritAi,
} from "../index.inlined.ts";

type FetchCalls = {
  groq: number;
  ivrit: number;
  audioDownload: number;
  bodyShapes: string[]; // "audio/ogg" | "application/json" | "multipart/form-data" | other
};

function stubFetch(opts: {
  groqResponse?: { status?: number; body?: unknown };
  ivritResponse?: { status?: number; body?: unknown };
}): { restore: () => void; calls: FetchCalls } {
  const orig = globalThis.fetch;
  const calls: FetchCalls = { groq: 0, ivrit: 0, audioDownload: 0, bodyShapes: [] };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    // Supabase REST stubs (used by buildVoicePromptBias internals)
    if (
      url.includes("whatsapp_member_mapping") ||
      url.includes("shopping_items") ||
      url.includes("/rest/v1/tasks") ||
      url.includes("/rest/v1/events")
    ) {
      return new Response("[]", { status: 200 });
    }

    if (url.includes("groq.com")) {
      calls.groq++;
      const ct = (init?.headers as Record<string, string> | undefined)?.["Content-Type"]
        ?? (init?.headers as Record<string, string> | undefined)?.["content-type"]
        ?? "multipart/form-data";
      calls.bodyShapes.push(ct);
      const r = opts.groqResponse ?? {};
      const body = r.body ?? { text: "שלום מ-Groq", language: "he", segments: [{ avg_logprob: -0.5, no_speech_prob: 0.1 }] };
      return new Response(JSON.stringify(body), { status: r.status ?? 200 });
    }

    if (url.includes("huggingface.cloud")) {
      calls.ivrit++;
      const ct = (init?.headers as Record<string, string> | undefined)?.["Content-Type"]
        ?? (init?.headers as Record<string, string> | undefined)?.["content-type"]
        ?? "";
      calls.bodyShapes.push(ct);
      const r = opts.ivritResponse ?? {};
      const body = r.body ?? { text: "שלום מ-ivrit" };
      return new Response(JSON.stringify(body), { status: r.status ?? 200 });
    }

    // Audio download stub for transcribeVoice top-level helper
    if (url.includes("stub.example") || url.includes("/media/")) {
      calls.audioDownload++;
      return new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), { status: 200 });
    }

    return new Response("[]", { status: 200 });
  };
  return { restore: () => { globalThis.fetch = orig; }, calls };
}

Deno.test("transcribeVoice routes to Groq when VOICE_PROVIDER unset (default)", async () => {
  Deno.env.delete("VOICE_PROVIDER");
  Deno.env.set("GROQ_API_KEY", "stub_groq");
  const { restore, calls } = stubFetch({});
  try {
    const result = await transcribeVoice("https://stub.example/audio.ogg", undefined, "hh_test");
    assertEquals(calls.groq, 1);
    assertEquals(calls.ivrit, 0);
    assertEquals(result.text, "שלום מ-Groq");
    assertEquals(result.quality, "ok");
  } finally {
    restore();
  }
});

Deno.test("transcribeVoice routes to Groq when VOICE_PROVIDER=groq (explicit)", async () => {
  Deno.env.set("VOICE_PROVIDER", "groq");
  Deno.env.set("GROQ_API_KEY", "stub_groq");
  const { restore, calls } = stubFetch({});
  try {
    const result = await transcribeVoice("https://stub.example/audio.ogg", undefined, "hh_test");
    assertEquals(calls.groq, 1);
    assertEquals(calls.ivrit, 0);
    assertEquals(result.text, "שלום מ-Groq");
  } finally {
    restore();
    Deno.env.delete("VOICE_PROVIDER");
  }
});

Deno.test("transcribeVoice routes to ivrit-ai when VOICE_PROVIDER=ivrit_ai_hf", async () => {
  Deno.env.set("VOICE_PROVIDER", "ivrit_ai_hf");
  Deno.env.set("IVRIT_AI_HF_URL", "https://stub.eu-west-1.aws.endpoints.huggingface.cloud");
  Deno.env.set("IVRIT_AI_HF_TOKEN", "hf_stubtoken");
  Deno.env.set("GROQ_API_KEY", "stub_groq");
  const { restore, calls } = stubFetch({});
  try {
    const result = await transcribeVoice("https://stub.example/audio.ogg", undefined, "hh_test");
    assertEquals(calls.ivrit, 1);
    assertEquals(calls.groq, 0);
    assertEquals(result.text, "שלום מ-ivrit");
    // Quality gate degraded — HF transformers ASR doesn't expose avg_logprob.
    assertEquals(result.quality, "ok");
  } finally {
    restore();
    Deno.env.delete("VOICE_PROVIDER");
    Deno.env.delete("IVRIT_AI_HF_URL");
    Deno.env.delete("IVRIT_AI_HF_TOKEN");
  }
});

Deno.test("transcribeVoice accepts ivrit_ai aliases (ivritai, ivrit-ai-hf)", async () => {
  Deno.env.set("IVRIT_AI_HF_URL", "https://stub.eu-west-1.aws.endpoints.huggingface.cloud");
  Deno.env.set("IVRIT_AI_HF_TOKEN", "hf_stubtoken");
  Deno.env.set("GROQ_API_KEY", "stub_groq");
  for (const alias of ["ivritai", "ivrit-ai-hf", "IVRIT_AI_HF"]) {
    Deno.env.set("VOICE_PROVIDER", alias);
    const { restore, calls } = stubFetch({});
    try {
      await transcribeVoice("https://stub.example/audio.ogg", undefined, "hh_test");
      assertEquals(calls.ivrit, 1, `alias=${alias} should route to ivrit-ai`);
      assertEquals(calls.groq, 0, `alias=${alias} should NOT call groq`);
    } finally {
      restore();
    }
  }
  Deno.env.delete("VOICE_PROVIDER");
  Deno.env.delete("IVRIT_AI_HF_URL");
  Deno.env.delete("IVRIT_AI_HF_TOKEN");
});

Deno.test("transcribeVoiceIvritAi parses HF transformers ASR response shape", async () => {
  Deno.env.set("IVRIT_AI_HF_URL", "https://stub.eu-west-1.aws.endpoints.huggingface.cloud");
  Deno.env.set("IVRIT_AI_HF_TOKEN", "hf_stubtoken");
  const { restore } = stubFetch({
    ivritResponse: { body: { text: "תזכירי לי לקנות חלב מחר" } },
  });
  try {
    const audio = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/ogg" });
    const result = await transcribeVoiceIvritAi(audio, "");
    assertEquals(result.text, "תזכירי לי לקנות חלב מחר");
    assertEquals(result.quality, "ok");
    assertEquals(result.language, "he");
  } finally {
    restore();
    Deno.env.delete("IVRIT_AI_HF_URL");
    Deno.env.delete("IVRIT_AI_HF_TOKEN");
  }
});

Deno.test("transcribeVoiceIvritAi handles missing IVRIT_AI_HF_URL by failing soft", async () => {
  Deno.env.delete("IVRIT_AI_HF_URL");
  Deno.env.delete("IVRIT_AI_HF_TOKEN");
  const audio = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/ogg" });
  const result = await transcribeVoiceIvritAi(audio, "");
  assertEquals(result.text, null);
  assertEquals(result.quality, "failed");
});

Deno.test("transcribeVoiceIvritAi handles HF API error by failing soft", async () => {
  Deno.env.set("IVRIT_AI_HF_URL", "https://stub.eu-west-1.aws.endpoints.huggingface.cloud");
  Deno.env.set("IVRIT_AI_HF_TOKEN", "hf_stubtoken");
  const { restore } = stubFetch({
    ivritResponse: { status: 503, body: { error: "model not loaded" } },
  });
  try {
    const audio = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/ogg" });
    const result = await transcribeVoiceIvritAi(audio, "");
    assertEquals(result.text, null);
    assertEquals(result.quality, "failed");
  } finally {
    restore();
    Deno.env.delete("IVRIT_AI_HF_URL");
    Deno.env.delete("IVRIT_AI_HF_TOKEN");
  }
});

Deno.test("transcribeVoiceIvritAi handles empty text response", async () => {
  Deno.env.set("IVRIT_AI_HF_URL", "https://stub.eu-west-1.aws.endpoints.huggingface.cloud");
  Deno.env.set("IVRIT_AI_HF_TOKEN", "hf_stubtoken");
  const { restore } = stubFetch({
    ivritResponse: { body: { text: "   " } }, // whitespace-only
  });
  try {
    const audio = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/ogg" });
    const result = await transcribeVoiceIvritAi(audio, "");
    assertEquals(result.text, null);
    assertEquals(result.quality, "failed");
  } finally {
    restore();
    Deno.env.delete("IVRIT_AI_HF_URL");
    Deno.env.delete("IVRIT_AI_HF_TOKEN");
  }
});

Deno.test("transcribeVoiceGroq still works as a standalone helper (regression)", async () => {
  Deno.env.set("GROQ_API_KEY", "stub_groq");
  const { restore, calls } = stubFetch({});
  try {
    const audio = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/ogg" });
    const result = await transcribeVoiceGroq(audio, "ירון, אביטל");
    assertEquals(result.text, "שלום מ-Groq");
    assertEquals(result.quality, "ok");
    assertEquals(calls.groq, 1);
  } finally {
    restore();
  }
});

// ─── Voice compare (ad-hoc QA) tests ─────────────────────────────────────

Deno.test("transcribeVoiceCompare returns both providers' results in parallel", async () => {
  Deno.env.set("IVRIT_AI_HF_URL", "https://stub.example/ivrit");
  Deno.env.set("IVRIT_AI_HF_TOKEN", "hf_stub");
  Deno.env.set("GROQ_API_KEY", "groq_stub");
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("groq.com")) {
      return new Response(JSON.stringify({ text: "ויטל הדריכלית", language: "he", segments: [] }), { status: 200 });
    }
    if (url.includes("stub.example/ivrit")) {
      return new Response(JSON.stringify({ text: "אביטל האדריכלית" }), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };
  try {
    const blob = new Blob([new Uint8Array([0, 1, 2])], { type: "audio/ogg" });
    const result = await transcribeVoiceCompare(blob, "");
    assertEquals(result.groq.text, "ויטל הדריכלית");
    assertEquals(result.ivrit.text, "אביטל האדריכלית");
    assertEquals(result.groq.quality, "ok");
    assertEquals(result.ivrit.quality, "ok");
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("IVRIT_AI_HF_URL");
    Deno.env.delete("IVRIT_AI_HF_TOKEN");
    Deno.env.delete("GROQ_API_KEY");
  }
});

Deno.test("transcribeVoiceCompare survives one provider failing", async () => {
  Deno.env.set("IVRIT_AI_HF_URL", "https://stub.example/ivrit");
  Deno.env.set("IVRIT_AI_HF_TOKEN", "hf_stub");
  Deno.env.set("GROQ_API_KEY", "groq_stub");
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("groq.com")) {
      return new Response(JSON.stringify({ text: "fine", language: "he", segments: [] }), { status: 200 });
    }
    if (url.includes("stub.example/ivrit")) {
      return new Response("server exploded", { status: 500 });
    }
    return new Response("[]", { status: 200 });
  };
  try {
    const blob = new Blob([new Uint8Array([0, 1, 2])], { type: "audio/ogg" });
    const result = await transcribeVoiceCompare(blob, "");
    assertEquals(result.groq.text, "fine");
    assertEquals(result.ivrit.text, null);
    assertEquals(result.ivrit.quality, "failed");
  } finally {
    globalThis.fetch = orig;
    Deno.env.delete("IVRIT_AI_HF_URL");
    Deno.env.delete("IVRIT_AI_HF_TOKEN");
    Deno.env.delete("GROQ_API_KEY");
  }
});

Deno.test("parseCompareWhitelist parses CSV with + prefix and whitespace", () => {
  Deno.env.set("VOICE_COMPARE_PHONES", " +972525937316 , 972559881835 ,  ");
  try {
    const set = parseCompareWhitelist();
    assertEquals(set.has("972525937316"), true);
    assertEquals(set.has("972559881835"), true);
    assertEquals(set.size, 2);
  } finally {
    Deno.env.delete("VOICE_COMPARE_PHONES");
  }
});

Deno.test("parseCompareWhitelist returns empty set when env var unset", () => {
  Deno.env.delete("VOICE_COMPARE_PHONES");
  assertEquals(parseCompareWhitelist().size, 0);
});
