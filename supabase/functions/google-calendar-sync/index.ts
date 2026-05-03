// ============================================================================
// Google Calendar Sync Edge Function
//
// Demo-minimum integration for the calendar.events OAuth scope.
// Accepts a Google access_token (provider_token from Supabase OAuth session)
// plus an event payload, and creates the event on the user's primary calendar.
//
// Request:
//   POST /functions/v1/google-calendar-sync
//   Headers: Authorization: Bearer <supabase_jwt> (Verify JWT = ON)
//   Body:    { accessToken: string, event: { title, scheduledFor, durationMinutes? } }
//
// Response:
//   { ok: true, htmlLink: string, eventId: string }
//   { ok: false, error: string, status?: number, detail?: string }
//
// No env vars. Token comes from request body — caller (web app) reads it from
// Supabase session.provider_token. Refresh tokens / DB persistence are a
// production follow-up after Google verification approves the scope.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface SyncRequest {
  accessToken: string;
  event: {
    title: string;
    scheduledFor: string;  // ISO 8601, e.g. "2026-05-01T11:00:00+03:00"
    durationMinutes?: number;
  };
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "POST only" }, 405);
  }

  let body: SyncRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid JSON" }, 400);
  }

  const { accessToken, event } = body;
  if (!accessToken || !event?.title || !event?.scheduledFor) {
    return jsonResponse({ ok: false, error: "missing fields" }, 400);
  }

  const startMs = new Date(event.scheduledFor).getTime();
  if (isNaN(startMs)) {
    return jsonResponse({ ok: false, error: "invalid scheduledFor" }, 400);
  }
  const endMs = startMs + (event.durationMinutes ?? 60) * 60_000;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const gcalRes = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: event.title,
        start: { dateTime: startIso, timeZone: "Asia/Jerusalem" },
        end: { dateTime: endIso, timeZone: "Asia/Jerusalem" },
        source: { title: "Sheli", url: "https://sheli.ai" },
      }),
    }
  );

  if (!gcalRes.ok) {
    const detail = await gcalRes.text();
    console.error("[gcal-sync] Google API error:", gcalRes.status, detail);
    return jsonResponse(
      { ok: false, error: "google_api_error", status: gcalRes.status, detail },
      502
    );
  }

  const created = await gcalRes.json();
  return jsonResponse({ ok: true, htmlLink: created.htmlLink, eventId: created.id });
});
