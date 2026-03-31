import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";

export function useAuth() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        setSession(session);
        if (session) fetchProfile(session.user.id);
        setLoading(false);
      })
      .catch((err) => {
        console.error("[Auth] getSession failed:", err);
        setLoading(false); // Always resolve loading, even on error
      });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);
        if (session) {
          await fetchProfile(session.user.id);
        } else {
          setProfile(null);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const fetchProfile = async (userId) => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    setProfile(data);
  };

  const signUp = async (email, password, displayName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: displayName },
      },
    });
    return { data, error };
  };

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { data, error };
  };

  const signInWithGoogle = async () => {
    // Use production URL for redirect (not localhost)
    const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    const redirectUrl = isLocal
      ? window.location.origin   // local dev: http://localhost:5173
      : "https://sheli.ai";  // production

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectUrl,
      },
    });
    return { data, error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
  };

  const updateProfile = async (updates) => {
    if (!session) return { error: "Not authenticated" };
    const { data, error } = await supabase
      .from("profiles")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", session.user.id)
      .select()
      .single();
    if (data) setProfile(data);
    return { data, error };
  };

  return {
    session,
    user: session?.user || null,
    profile,
    loading,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    updateProfile,
    fetchProfile,
  };
}
