import { supabase } from "./supabase.js";

const FUNCTION_URL = "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/google-calendar-sync";

export async function syncEventToGoogleCalendar({ accessToken, event }) {
  const { data: sessionData } = await supabase.auth.getSession();
  const supabaseJwt = sessionData?.session?.access_token;
  if (!supabaseJwt) throw new Error("not_authenticated");

  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${supabaseJwt}`,
    },
    body: JSON.stringify({ accessToken, event }),
  });

  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `http_${res.status}`);
  }
  return json;
}
