import { createClient } from "@supabase/supabase-js";

// ─── Supabase auth verification ───
const SB_URL = "https://wzwwtghtnkapdwlgnrxr.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6d3d0Z2h0bmthcGR3bGducnhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMTg2NDYsImV4cCI6MjA4OTc5NDY0Nn0.P8NlRjUciAewFvKsaPAxL_x_5FHuGyQXIcrTKmxyd9g";

// ─── Rate limiting (in-memory, per-user, resets on cold start) ───
const rateLimits = new Map(); // userId -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 20; // 20 requests per minute per user

function checkRateLimit(userId) {
  const now = Date.now();
  const entry = rateLimits.get(userId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(userId, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

// ─── Allowed models (whitelist) ───
const ALLOWED_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-3-5-sonnet-20241022",
];
const MAX_TOKENS_CAP = 4096;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // ─── Auth: verify Supabase JWT ───
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return res.status(401).json({ error: "Missing authorization token" });
  }

  const supabase = createClient(SB_URL, SB_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // ─── Rate limiting ───
  if (!checkRateLimit(user.id)) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  // ─── Input validation ───
  const body = req.body;
  if (!body || !body.messages || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "Invalid request: messages array required" });
  }

  // Enforce model whitelist
  const model = body.model;
  if (!model || !ALLOWED_MODELS.includes(model)) {
    return res.status(400).json({ error: `Invalid model. Allowed: ${ALLOWED_MODELS.join(", ")}` });
  }

  // Cap max_tokens
  const maxTokens = Math.min(body.max_tokens || MAX_TOKENS_CAP, MAX_TOKENS_CAP);

  // SECURITY: Cap system prompt and message sizes to prevent cost amplification
  if (body.system && typeof body.system === "string" && body.system.length > 8000) {
    return res.status(400).json({ error: "System prompt too long" });
  }
  const totalInputChars = body.messages.reduce((sum, m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    return sum + content.length;
  }, 0);
  if (totalInputChars > 50000) {
    return res.status(400).json({ error: "Input messages too long" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,  // No VITE_ prefix — server-only
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: body.system,
        messages: body.messages,
      }),
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error("[api/chat] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
