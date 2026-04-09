import { useState, useEffect, useRef } from "react";
import T from "./locales/index.js";
import "./styles/app.css";
import { supabase, lsGet, lsSet, uid8, loadHousehold, saveTask, saveShoppingItem, saveEvent, deleteTask, deleteShoppingItem, deleteEvent, clearDoneTasks, clearGotShopping, saveAllTasks, saveAllShopping, saveAllEvents, loadMessages, insertMessage } from "./lib/supabase.js";
import buildPrompt from "./lib/prompt.js";
import { analytics, identifyUser } from "./lib/analytics.js";
import Setup from "./components/Setup.jsx";
import AuthScreen from "./components/AuthScreen.jsx";
import WelcomeScreen from "./components/WelcomeScreen.jsx";
import LandingPage from "./components/LandingPage.jsx";
import { useAuth } from "./hooks/useAuth.js";
import TasksView from "./components/TasksView.jsx";
import ShoppingView from "./components/ShoppingView.jsx";
import WeekView from "./components/WeekView.jsx";
import MenuPanel from "./components/modals/MenuPanel.jsx";
import { ChatIcon, TasksIcon, ShoppingIcon, WeekIcon, MicIcon, StopIcon, SendIcon, VoiceWaveIcon } from "./components/Icons.jsx";
import JoinOrCreate from "./components/JoinOrCreate.jsx";
import { detectHousehold, joinByCode } from "./lib/household-detect.js";
import AdminDashboard from "./components/AdminDashboard.jsx";

const SHELI_PHONE = "972555175553";
const SHELI_WA_LINK = `https://wa.me/${SHELI_PHONE}?text=${encodeURIComponent("שלום שלי")}`;
const SHELI_PHONE_DISPLAY = "+972 55-517-5553";
const OTP_SENDER_URL = "https://wzwwtghtnkapdwlgnrxr.supabase.co/functions/v1/otp-sender";

// Fire-and-forget: send WhatsApp bridge nudge to new phone-auth users
async function sendOtpBridge(phone, accessToken) {
  if (!phone || !accessToken) return;
  try {
    await fetch(OTP_SENDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
      body: JSON.stringify({ action: "bridge", phone }),
    });
    console.log("[Boot] OTP bridge message sent");
  } catch (err) {
    console.warn("[Boot] OTP bridge failed (non-fatal):", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function Sheli() {
  const [screen, setScreen]       = useState("loading");
  const [tab, setTab]             = useState("chat");
  const [household, setHousehold] = useState(null);
  const [detectedHh, setDetectedHh] = useState(null); // Auto-detected household for join flow
  const [user, setUser]           = useState(null);
  const [lang, setLang]           = useState("en");
  const [allMsgs, setAllMsgs]     = useState({});
  const [tasks, setTasks]         = useState([]);
  const [shopping, setShopping]   = useState([]);
  const [events, setEvents]       = useState([]);
  const [rotations, setRotationsS] = useState([]);
  const [input, setInput]         = useState("");
  const [busy, setBusy]           = useState(false);
  const [showMenu, setShowMenu]   = useState(false);
  const [theme, setTheme]         = useState(() => lsGet("sheli-theme") || "auto");
  const [pendingDelete, setPendingDelete] = useState(null); // M4: {type, id} — confirm before delete
  const [dataLoaded, setDataLoaded]     = useState(false); // M9: false until first household load
  // L2 fix: convert to state so it reacts to changes (e.g. after handleSetup)
  const [isFounder, setIsFounder] = useState(() => !!lsGet("sheli-founder"));
  // Admin dashboard — one-time URL check on mount
  const [isAdmin] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("admin") === "1") { window.history.replaceState({}, "", window.location.pathname); return true; }
    return false;
  });
  const { session, user: authUser, profile, loading: authLoading, signOut } = useAuth();
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const t   = T[lang] || T.en;
  const dir = t.dir;
  const msgs = session?.user?.id ? (allMsgs[session.user.id] || []) : [];
  const isRtl = dir === "rtl";

  // ── Boot ──
  // Runs when auth resolves. Re-runs when session changes (null → valid).
  const lastSessionId = useRef(null);

  useEffect(() => {
    if (authLoading) return;

    const currentId = session?.user?.id || null;
    const wasNull = lastSessionId.current === null;
    const isNew = currentId && currentId !== lastSessionId.current;
    lastSessionId.current = currentId;

    // Skip if same session (prevents re-runs from token refreshes)
    if (!wasNull && !isNew && currentId) return;

    console.log("[Boot]", currentId ? `session: ${currentId}` : "no session");

    if (session?.user) identifyUser(session.user.id, { email: session.user.email });

    if (!session) {
      // ?source=wa → skip landing page, go straight to auth (Path B: WhatsApp dashboard users)
      const params = new URLSearchParams(window.location.search);
      if (params.get("source") === "wa") {
        setScreen("auth");
      } else {
        setScreen("welcome");
      }
      return;
    }

    // Authenticated → proceed with household loading (with 8s global timeout)
    const bootAsync = async () => {
      const params = new URLSearchParams(window.location.search);
      const joinId = params.get("join");
      console.log("[Boot] Starting async boot. joinId:", joinId, "hhId:", lsGet("sheli-hhid"));

      const loadData = async (id) => {
        const v2 = await loadHousehold(id);
        if (!v2) return null;
        let msgs = [];
        try { msgs = await loadMessages(id, session.user.id); } catch (e) { console.warn("[Boot] loadMessages:", e.message); }
        return { ...v2, msgs };
      };

      if (joinId) {
        try {
          const data = await loadData(joinId);
          if (data) {
            setHouseholdS(data.hh); setLang(data.hh.lang || "en");
            setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []); setRotationsS(data.rotations || []);
            if (data.msgs?.length > 0) setAllMsgs({ [session.user.id]: data.msgs });
            window.history.replaceState({}, "", window.location.pathname);
            setScreen("pick"); return;
          }
        } catch (e) { console.error("[Boot] Join load error:", e); }
      }
      // Try to load household from localStorage
      const hhId = lsGet("sheli-hhid");
      if (hhId) {
        try {
          const data = await loadData(hhId);
          if (data) {
            setHouseholdS(data.hh); setLang(data.hh.lang || "en");
            setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []); setRotationsS(data.rotations || []);
            if (data.msgs?.length > 0) setAllMsgs({ [session.user.id]: data.msgs });
            const savedUser = lsGet("sheli-user");
            if (savedUser) {
              const stillExists = data.hh.members.find(m => m.id === savedUser.id)
                || data.hh.members.find(m => m.name === savedUser.name);
              if (stillExists) {
                setUser(stillExists);
                lsSet("sheli-user", stillExists);
                setDataLoaded(true); setScreen("chat"); return;
              }
            }
            setScreen("pick"); return;
          }
        } catch (e) { console.error("[Boot] Household load error:", e); }
      }

      // No household in localStorage — try auto-detect (with 3s timeout)
      console.log("[Boot] No hhId, running auto-detect...");
      try {
        const detected = await Promise.race([
          detectHousehold(session.user.id, session.user.email, session.user.phone),
          new Promise(resolve => setTimeout(() => { console.warn("[Boot] Auto-detect timeout"); resolve(null); }, 5000)),
        ]);
        if (detected) {
          console.log("[Boot] Auto-detected household:", detected.name, detected.id);
          lsSet("sheli-hhid", detected.id);
          // Navigate immediately with detected info, load full data in background
          setHouseholdS({ name: detected.name, lang: detected.lang || "he", members: detected.members || [], id: detected.id });
          setLang(detected.lang || "he");
          setScreen("pick");
          // Load full data in background
          loadData(detected.id).then(data => {
            if (data) {
              setHouseholdS(data.hh); setLang(data.hh.lang || "en");
              setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []); setRotationsS(data.rotations || []);
              if (data.msgs?.length > 0) setAllMsgs({ [session.user.id]: data.msgs });
            }
          }).catch(e => console.warn("[Boot] Background load:", e));
          return;
        }
      } catch (e) { console.warn("[Boot] Auto-detect error:", e); }

      // Send WhatsApp bridge nudge for phone-auth users without a household
      if (session.user.phone && session.user.app_metadata?.provider === "phone") {
        sendOtpBridge(session.user.phone, session.access_token);
      }

      // Show join-or-create screen (with or without detected household)
      setScreen("join-or-create");
    };

    // Run boot with 8s safety net — but only override if still on "loading"
    let bootDone = false;
    bootAsync().then(() => { bootDone = true; });
    setTimeout(() => {
      if (!bootDone) {
        console.warn("[Boot] Global timeout — forcing join-or-create");
        setScreen(prev => prev === "loading" ? "join-or-create" : prev);
      }
    }, 8000);

  }, [authLoading, session]); // runs when auth resolves or session changes

  // ── Theme ──
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    lsSet("sheli-theme", theme);
  }, [theme]);

  // ── Scroll ──
  useEffect(() => {
    if (tab === "chat") bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy, tab]);

  // Refs always in sync with state
  const householdRef = useRef(null);
  const tasksRef     = useRef([]);
  const shoppingRef  = useRef([]);
  const eventsRef    = useRef([]);

  const setHouseholdS = (v) => { householdRef.current = v; setHousehold(v); };
  const setTasksS     = (v) => { tasksRef.current     = v; setTasks(v);     };
  const setShoppingS  = (v) => { shoppingRef.current  = v; setShopping(v);  };
  const setEventsS    = (v) => { eventsRef.current    = v; setEvents(v);    };

  // ── Realtime sync ──
  const lastSaveRef = useRef(0);

  // ── Realtime sync (V2 tables only) ──
  useEffect(() => {
    if (screen !== "chat") return;
    const hhId = lsGet("sheli-hhid");
    if (!hhId) return;
    const authUserId = session?.user?.id;

    // M1 fix: per-table reloads instead of reloading all 5 tables for each change
    const TASK_MAP = { assigned_to: 'assignedTo', completed_by: 'completedBy', completed_at: 'completedAt' };
    const EVENT_MAP = { assigned_to: 'assignedTo', scheduled_for: 'scheduledFor' };
    const fromDb = (obj, map) => { const rev = Object.fromEntries(Object.entries(map).map(([k,v])=>[v,k])); const out={}; for(const[k,v]of Object.entries(obj)){out[Object.entries(map).find(([mk,mv])=>mv===k)?.[0]||Object.entries(rev).find(([rk,rv])=>rv===k)?.[0]||k]=v;} return out; };

    const reloadTasks = async () => {
      if (Date.now() - lastSaveRef.current < 3000) return;
      const { data } = await supabase.from("tasks").select("*").eq("household_id", hhId);
      if (data) setTasksS(data.map(t => { const o = {...t}; if(o.assigned_to){o.assignedTo=o.assigned_to;delete o.assigned_to;} if(o.completed_by){o.completedBy=o.completed_by;delete o.completed_by;} if(o.completed_at){o.completedAt=o.completed_at;delete o.completed_at;} return o; }));
    };
    const reloadShopping = async () => {
      if (Date.now() - lastSaveRef.current < 3000) return;
      const { data } = await supabase.from("shopping_items").select("*").eq("household_id", hhId);
      if (data) setShoppingS(data);
    };
    const reloadEvents = async () => {
      if (Date.now() - lastSaveRef.current < 3000) return;
      const { data } = await supabase.from("events").select("*").eq("household_id", hhId);
      if (data) setEventsS(data.map(e => { const o={...e}; if(o.assigned_to){o.assignedTo=o.assigned_to;delete o.assigned_to;} if(o.scheduled_for){o.scheduledFor=o.scheduled_for;delete o.scheduled_for;} return o; }));
    };
    const reloadHousehold = async () => {
      if (Date.now() - lastSaveRef.current < 3000) return;
      const [hhRes, memRes] = await Promise.all([
        supabase.from("households_v2").select("*").eq("id", hhId).single(),
        supabase.from("household_members").select("*").eq("household_id", hhId),
      ]);
      if (hhRes.data) setHouseholdS({ id: hhRes.data.id, name: hhRes.data.name, lang: hhRes.data.lang || "he", members: (memRes.data||[]).map(m=>({id:m.id,name:m.display_name,userId:m.user_id})) });
    };
    const reloadMessages = async () => {
      if (!authUserId || Date.now() - lastSaveRef.current < 3000) return;
      const msgs = await loadMessages(hhId, authUserId);
      if (msgs) setAllMsgs(prev => ({ ...prev, [authUserId]: msgs }));
    };

    const ch1 = supabase.channel(`tasks-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `household_id=eq.${hhId}` }, reloadTasks)
      .subscribe();
    const ch2 = supabase.channel(`shopping-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items", filter: `household_id=eq.${hhId}` }, reloadShopping)
      .subscribe();
    const ch3 = supabase.channel(`events-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `household_id=eq.${hhId}` }, reloadEvents)
      .subscribe();
    const ch4 = supabase.channel(`household-${hhId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "households_v2", filter: `id=eq.${hhId}` }, reloadHousehold)
      .subscribe();
    const ch5 = supabase.channel(`messages-${hhId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `household_id=eq.${hhId}` }, reloadMessages)
      .subscribe();

    const reloadRotations = async () => {
      if (Date.now() - lastSaveRef.current < 3000) return;
      const { data } = await supabase.from("rotations").select("*").eq("household_id", hhId).eq("active", true);
      if (data) setRotationsS(data.map(r => ({
        ...r,
        members: typeof r.members === "string" ? JSON.parse(r.members) : r.members,
        frequency: r.frequency && typeof r.frequency === "string" ? JSON.parse(r.frequency) : r.frequency,
      })));
    };
    const ch6 = supabase.channel(`rotations-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rotations", filter: `household_id=eq.${hhId}` }, reloadRotations)
      .subscribe();

    return () => {
      supabase.removeChannel(ch1);
      supabase.removeChannel(ch2);
      supabase.removeChannel(ch3);
      supabase.removeChannel(ch4);
      supabase.removeChannel(ch5);
      supabase.removeChannel(ch6);
    };
  }, [screen]);

  // ── Setup done ──
  const setupRunning = useRef(false);
  const handleSetup = async (hh) => {
    if (setupRunning.current) return;
    setupRunning.current = true;

    const hhId = uid8();
    hh.id = hhId;
    lsSet("sheli-hhid", hhId);
    lsSet("sheli-founder", true);
    setIsFounder(true);

    setHouseholdS(hh); setLang(hh.lang || "en");
    setTasksS([]); setShoppingS([]); setEventsS([]); setRotationsS([]);
    const founder = hh.members[0];
    if (founder) {
      lsSet("sheli-user", founder);
      setUser(founder);
    }
    setScreen("connect-wa");
    analytics.householdCreated(hh.lang || "en", hh.members.length);

    try {
      const authUserId = session?.user?.id;
      // H3 fix: AWAIT household insert before members (FK dependency)
      const { error: hhErr } = await supabase.from("households_v2").insert({
        id: hhId, name: hh.name, lang: hh.lang || "he", created_by: authUserId,
      });
      if (hhErr) console.warn("[Setup] v2:", hhErr);

      // H4 fix: pass generated ID so local state matches DB
      if (founder) {
        await supabase.from("household_members").insert({
          id: founder.id, household_id: hhId, display_name: founder.name, role: "founder", user_id: authUserId,
        }).catch(e => console.warn("[Setup] founder:", e));
      }
      for (const member of hh.members.slice(1)) {
        supabase.from("household_members").insert({
          id: member.id, household_id: hhId, display_name: member.name, role: "member",
        }).catch(e => console.warn("[Setup] member:", e));
      }
    } finally {
      // H1 fix: always reset so setup can run again after doReset
      setupRunning.current = false;
    }
  };

  // ── Reset ──
  const doReset = async () => {
    const hhId = lsGet("sheli-hhid");
    if (hhId) {
      try {
        await supabase.from("households_v2").delete().eq("id", hhId);
      } catch (e) { console.warn("[Reset]", e); }
    }
    localStorage.removeItem("sheli-hhid");
    localStorage.removeItem("sheli-msgs");
    localStorage.removeItem("sheli-user");
    localStorage.removeItem("sheli-founder");
    localStorage.removeItem("sheli-onboarded");
    setHousehold(null); setUser(null); setAllMsgs({}); setTasksS([]); setShoppingS([]); setEventsS([]); setRotationsS([]); setInput("");
    setShowMenu(false); setScreen("setup");
  };

  // ── Menu handlers ──
  const handleRenameUser = async (newName) => {
    if (!newName || newName === user.name) return;
    const updatedMembers = household.members.map(m =>
      m.id === user.id ? { ...m, name: newName } : m
    );
    const updatedHh = { ...household, members: updatedMembers };
    const updatedUser = { ...user, name: newName };
    setHouseholdS(updatedHh); setUser(updatedUser);
    lsSet("sheli-user", updatedUser);
    lastSaveRef.current = Date.now();
    supabase.from("household_members").update({ display_name: newName }).eq("id", user.id).catch(e => console.error("[renameUser]", e));
  };
  const handleRenameMember = async (memberId, newName) => {
    if (!newName || !household) return;
    const updatedMembers = household.members.map(m =>
      m.id === memberId ? { ...m, name: newName } : m
    );
    const updatedHh = { ...household, members: updatedMembers };
    setHouseholdS(updatedHh);
    lastSaveRef.current = Date.now();
    supabase.from("household_members").update({ display_name: newName }).eq("id", memberId).catch(e => console.error("[renameMember]", e));
  };

  const handleRenameHousehold = async (newName) => {
    if (!newName || !household) return;
    const updatedHh = { ...household, name: newName };
    setHouseholdS(updatedHh);
    lastSaveRef.current = Date.now();
    supabase.from("households_v2").update({ name: newName }).eq("id", household.id).catch(e => console.error("[renameHH]", e));
  };

  const handleAddMember = async (name) => {
    if (!name || !household) return;
    const newMember = { id: uid8(), name };
    const updatedHh = { ...household, members: [...household.members, newMember] };
    setHouseholdS(updatedHh);
    lastSaveRef.current = Date.now();
    supabase.from("household_members").insert({ household_id: household.id, display_name: name, role: "member" }).catch(e => console.error("[addMember]", e));
  };

  const handleRemoveMember = async (memberId) => {
    if (!household) return;
    const updatedHh = { ...household, members: household.members.filter(m => m.id !== memberId) };
    setHouseholdS(updatedHh);
    lastSaveRef.current = Date.now();
    try {
      await supabase.from("household_members").delete().eq("id", memberId).eq("household_id", household.id);
    } catch (e) { console.error("[removeMember]", e); }
    lastSaveRef.current = Date.now();
  };

  // ── Language switch ──
  const switchLang = async (l) => {
    analytics.languageSwitched(lang, l);
    setLang(l);
    if (household) {
      const updated = { ...household, lang: l };
      setHouseholdS(updated);
      lastSaveRef.current = Date.now();
      supabase.from("households_v2").update({ lang: l }).eq("id", household.id).catch(e => console.error("[switchLang]", e));
    }
  };

  // ── Toggle/delete ──
  const toggleTask = async (id) => {
    const n = tasks.map(x => {
      if (x.id !== id) return x;
      const nowDone = !x.done;
      return { ...x, done: nowDone, completedBy: nowDone ? user.name : null, completedAt: nowDone ? new Date().toISOString() : null };
    });
    setTasksS(n);
    if (n.find(x => x.id === id)?.done) analytics.taskCompleted();
    const hhId = lsGet("sheli-hhid");
    lastSaveRef.current = Date.now();
    const updated = n.find(x => x.id === id);
    if (hhId && updated) saveTask(hhId, updated);
  };
  const claimTask = async (id, name) => {
    const n = tasks.map(x => x.id === id ? { ...x, assignedTo: name } : x);
    setTasksS(n);
    const hhId = lsGet("sheli-hhid");
    lastSaveRef.current = Date.now();
    const updated = n.find(x => x.id === id);
    if (hhId && updated) saveTask(hhId, updated);
  };
  const toggleShop = async (id) => {
    const n = shopping.map(x => x.id === id ? { ...x, got: !x.got } : x);
    setShoppingS(n);
    if (n.find(x => x.id === id)?.got) analytics.shoppingItemGot();
    const hhId = lsGet("sheli-hhid");
    lastSaveRef.current = Date.now();
    const updated = n.find(x => x.id === id);
    if (hhId && updated) saveShoppingItem(hhId, updated);
  };
  // M4 fix: two-tap delete — first tap shows "Sure?", second tap deletes
  const deleteItem = async (type, id) => {
    if (!pendingDelete || pendingDelete.type !== type || pendingDelete.id !== id) {
      setPendingDelete({ type, id });
      // Auto-clear after 3 seconds if user doesn't confirm
      setTimeout(() => setPendingDelete(prev => prev?.id === id ? null : prev), 3000);
      return;
    }
    setPendingDelete(null);
    const hhId = lsGet("sheli-hhid");
    lastSaveRef.current = Date.now();
    if (type === "task") {
      setTasksS(tasksRef.current.filter(x => x.id !== id));
      if (hhId) deleteTask(hhId, id);
    } else {
      setShoppingS(shoppingRef.current.filter(x => x.id !== id));
      if (hhId) deleteShoppingItem(hhId, id);
    }
  };
  const clearDone = async () => {
    setTasksS(tasks.filter(x => !x.done));
    const hhId = lsGet("sheli-hhid");
    if (hhId) {
      lastSaveRef.current = Date.now();
      await clearDoneTasks(hhId);
      lastSaveRef.current = Date.now(); // refresh debounce after bulk delete completes
    }
  };
  const clearGot = async () => {
    setShoppingS(shopping.filter(x => !x.got));
    const hhId = lsGet("sheli-hhid");
    if (hhId) {
      lastSaveRef.current = Date.now();
      await clearGotShopping(hhId);
      lastSaveRef.current = Date.now(); // refresh debounce after bulk delete completes
    }
  };
  const deleteEventHandler = async (id) => {
    setEventsS(events.filter(x => x.id !== id));
    const hhId = lsGet("sheli-hhid");
    lastSaveRef.current = Date.now();
    if (hhId) deleteEvent(hhId, id);
  };

  // ── Send ──
  const send = async (text) => {
    const content = (text || input).trim();
    if (!content || busy || !user) return;
    const authUserId = session?.user?.id;
    const hhId = lsGet("sheli-hhid");
    const uMsg = { role: "user", content, ts: Date.now() };
    const prev = allMsgs[authUserId] || [];
    const updated = [...prev, uMsg];
    const nextAll = { ...allMsgs, [authUserId]: updated };
    setAllMsgs(nextAll); setInput(""); setBusy(true); setTab("chat");

    if (hhId && authUserId) insertMessage(hhId, authUserId, uMsg).catch(e => console.warn("[send] msg:", e));
    analytics.aiMessageSent(lang);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session?.access_token || ""}`,
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1200,
          // H5 fix: use refs for fresh state (closures go stale on rapid sends)
          system: buildPrompt(householdRef.current, tasksRef.current, shoppingRef.current, eventsRef.current, user, lang),
          messages: updated.slice(-20).map(m => ({ role: m.role, content: m.content })),
        })
      });
      const data = await res.json();
      const raw = (data.content?.[0]?.text || "{}").replace(/```json\n?|```/g, "").trim();
      let parsed = { message: t.genericError, tasks, shopping };
      try { parsed = JSON.parse(raw); } catch { parsed.message = raw || parsed.message; }

      const aMsg = { role: "assistant", content: parsed.message, ts: Date.now() };
      const finalMsgs = [...updated, aMsg];
      const finalAll = { ...nextAll, [authUserId]: finalMsgs };

      const mergeLists = (aiList, current) => {
        if (!Array.isArray(aiList)) return current;
        if (aiList.length === 0 && current.length > 0) return current;
        const aiIds = new Set(aiList.map(x => x.id));
        const kept = current.filter(x => !aiIds.has(x.id) && x.id);
        return [...aiList, ...kept];
      };
      analytics.aiMessageReceived(lang, !!parsed.tasks, !!parsed.shopping, !!parsed.events);
      if (Array.isArray(parsed.tasks)) parsed.tasks.filter(t => !tasksRef.current.find(x => x.id === t.id)).forEach(() => analytics.taskCreated());
      if (Array.isArray(parsed.shopping)) parsed.shopping.filter(s => !shoppingRef.current.find(x => x.id === s.id)).forEach(() => analytics.shoppingItemAdded());
      if (Array.isArray(parsed.events)) parsed.events.filter(e => !eventsRef.current.find(x => x.id === e.id)).forEach(() => analytics.eventCreated());

      // H5 fix: merge against fresh refs, not stale closures
      const newTasks = mergeLists(parsed.tasks, tasksRef.current);
      const newShop = mergeLists(parsed.shopping, shoppingRef.current);
      const newEvents = mergeLists(parsed.events, eventsRef.current);
      setAllMsgs(finalAll); setTasksS(newTasks); setShoppingS(newShop); setEventsS(newEvents);

      lastSaveRef.current = Date.now();
      if (hhId && authUserId) insertMessage(hhId, authUserId, aMsg).catch(e => console.warn("[send] aMsg:", e));
      if (hhId) {
        if (Array.isArray(parsed.tasks)) saveAllTasks(hhId, newTasks).catch(e => console.warn("[send] tasks:", e));
        if (Array.isArray(parsed.shopping)) saveAllShopping(hhId, newShop).catch(e => console.warn("[send] shop:", e));
        if (Array.isArray(parsed.events)) saveAllEvents(hhId, newEvents).catch(e => console.warn("[send] events:", e));
      }
    } catch {
      const aMsg = { role: "assistant", content: t.networkError, ts: Date.now() };
      setAllMsgs({ ...nextAll, [authUserId]: [...updated, aMsg] });
    }
    setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert(dir === "rtl" ? "הדפדפן שלך לא תומך בהקלטה קולית" : "Your browser doesn't support voice input"); return; }
    const rec = new SR();
    rec.lang = lang === "he" ? "he-IL" : "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onstart  = () => setListening(true);
    rec.onend    = () => setListening(false);
    rec.onerror  = () => setListening(false);
    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setInput(prev => prev ? prev + " " + transcript : transcript);
      analytics.voiceInputUsed(lang);
    };
    recognitionRef.current = rec;
    rec.start();
  };

  const stopVoice = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };
  const openTasks   = tasks.filter(x => !x.done).length;
  const neededItems = shopping.filter(x => !x.got).length;
  const userName    = user?.name || "";
  const starters    = [t.s1, t.s2, t.s3(userName), t.s4];

  // ── Screens ──
  if (isAdmin && ["28daa344-ad5a-449b-8e36-f6296bb2f51c","9698d5df-e40e-4f2b-a91e-a911f14fe1c8","dc552ffd-65f5-4943-a64a-8f6d56c8578a"].includes(session?.user?.id)) {
    return <AdminDashboard session={session} onBack={() => window.location.href = "/"} />;
  }

  if (screen === "loading") return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"var(--cream)",gap:12}}>
      <img src="/icons/icon.svg" alt="sheli" style={{width:72,height:72,borderRadius:16,
        filter:"drop-shadow(0 4px 12px rgba(232,114,92,0.25))"}} />
      <div style={{fontSize:13,color:"var(--muted)",fontWeight:300}}>
        {(T[lang] || T.en).loading}
      </div>
    </div>
  );

  if (screen === "welcome") return (
    <LandingPage
      key="landing-page"
      onGetStarted={(l) => { setLang(l || "he"); setScreen("auth"); }}
      onSignIn={(l) => { setLang(l || "he"); setScreen("auth"); }}
    />
  );

  if (screen === "auth") return (
    <AuthScreen
      onBack={() => setScreen("welcome")}
      lang={lang}
    />
  );

  if (screen === "join-or-create") return (
    <JoinOrCreate
      lang={lang}
      detectedHousehold={detectedHh}
      onJoinHousehold={async (hhId) => {
        const info = await joinByCode(hhId);
        lsSet("sheli-hhid", info.id);
        // Link auth user to this household
        try {
          await supabase.from("household_members").upsert({
            household_id: info.id,
            user_id: session?.user?.id,
            display_name: session?.user?.user_metadata?.full_name || session?.user?.email || "Member",
            role: "member",
          }, { onConflict: "household_id,user_id", ignoreDuplicates: true });
        } catch (e) { console.warn("[Join] member link error:", e); }
        // Reload to pick up the household
        window.location.reload();
      }}
      onCreateNew={() => setScreen("setup")}
    />
  );

  if (screen === "setup") return <Setup onDone={handleSetup} initialLang={lang !== "en" ? lang : null} />;

  // ── Connect WhatsApp screen (post-setup onboarding) ──
  if (screen === "connect-wa") {
    const wDir = (household?.lang || "en") === "he" ? "rtl" : "ltr";
    const wFont = wDir === "rtl" ? "'Heebo',sans-serif" : "'Nunito',sans-serif";
    const wt = T[household?.lang || "en"] || T.en;
    return (
      <div className="cwa-wrap" style={{fontFamily:wFont}} dir={wDir}>
        <div className="cwa-icon">💬</div>
        <div className="cwa-title">{wt.waTitle}</div>
        <p className="cwa-sub">{wt.waSub}</p>
        <div className="cwa-card">
          <div className="cwa-step">{wt.waStep1}</div>
          <div className="cwa-phone">{SHELI_PHONE_DISPLAY}</div>
          <div className="cwa-step">{wt.waStep2}</div>
        </div>
        <a href={SHELI_WA_LINK} target="_blank" rel="noopener noreferrer" className="cwa-btn">
          {wt.waBtn}
        </a>
        <button onClick={() => { lsSet("sheli-onboarded", true); setScreen(user ? "chat" : "pick"); }} className="cwa-later">
          {wt.waLater}
        </button>
      </div>
    );
  }

  // ── User picker screen ──
  if (screen === "pick") {
    const pickDir = (household?.lang || "en") === "he" ? "rtl" : "ltr";
    const pickFont = pickDir === "rtl" ? "'Heebo',sans-serif" : "'Nunito',sans-serif";
    return (
      <div className="pick-wrap" style={{fontFamily:pickFont}} dir={pickDir}>
        <div className="setup-mark">sheli</div>
        <p className="pick-welcome">
          {pickDir === "rtl"
            ? `ברוכים הבאים, ${household.name}`
            : `Welcome, ${household.name}`}
        </p>
        <p className="pick-question">
          {pickDir === "rtl" ? "איך קוראים לך?" : "Who are you?"}
        </p>
        <div className="pick-list">
          {household.members.map(m => (
            <button key={m.id} className="pick-member"
              onClick={() => {
                if (!lsGet("sheli-hhid") && household?.id) {
                  lsSet("sheli-hhid", household.id);
                }
                lsSet("sheli-user", m);
                setUser(m);
                setDataLoaded(true); setScreen("chat");
              }}>
              {m.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Menu panel */}
      {showMenu && (
        <MenuPanel
          user={user}
          household={household}
          lang={lang}
          theme={theme}
          isFounder={isFounder}
          email={session?.user?.email || ""}
          onClose={() => setShowMenu(false)}
          onRenameUser={handleRenameUser}
          onRenameMember={handleRenameMember}
          onRenameHousehold={handleRenameHousehold}
          onAddMember={handleAddMember}
          onRemoveMember={handleRemoveMember}
          onSwitchLang={switchLang}
          onSetTheme={setTheme}
          onSwitchUser={() => { setShowMenu(false); setUser(null); lsSet("sheli-user", null); setScreen("pick"); }}
          onSignOut={async () => {
            // H2 fix: clear all sheli-* keys to prevent cross-user data leak
            localStorage.removeItem("sheli-hhid");
            localStorage.removeItem("sheli-user");
            localStorage.removeItem("sheli-founder");
            localStorage.removeItem("sheli-onboarded");
            localStorage.removeItem("sheli-msgs");
            setHousehold(null); setUser(null); setAllMsgs({}); setTasksS([]); setShoppingS([]); setEventsS([]); setRotationsS([]); setIsFounder(false);
            await signOut();
            setShowMenu(false); setScreen("welcome");
          }}
          onReset={doReset}
        />
      )}

      <div className="app" dir={dir}>

        {/* ── Header ── */}
        <div className="header">
          <div className="header-side left">
            <button className="icon-btn" onClick={() => setShowMenu(true)} title={t.menuProfile}
              style={{fontSize:20,opacity:0.7}}>
              ☰
            </button>
          </div>
          <div className="header-mid">
            <div className="wordmark">sheli</div>
          </div>
          <div className="header-side right" />
        </div>

        {/* ── Tab body ── */}
        <div className="tab-body">

          {tab === "chat" && (
            <>
              <div className="messages">
                {msgs.length === 0 ? (
                  <div className="empty">
                    <div className="empty-hi">{t.hiName(userName)}</div>
                    <p className="empty-sub">{t.chatSub}</p>
                    <div className="starters">
                      {starters.map(s => (
                        <button key={s} className="starter" onClick={() => send(s)}>{s}</button>
                      ))}
                    </div>
                  </div>
                ) : (
                  msgs.map((m, i) => (
                    <div key={i} className={`msg-wrap ${m.role}`}>
                      <div className="msg-label">{m.role==="user" ? userName : t.sheliLabel}</div>
                      <div className="bubble">{m.content}</div>
                    </div>
                  ))
                )}
                {busy && (
                  <div className="msg-wrap thinking-wrap">
                    <div className="msg-label">{t.sheliLabel}</div>
                    <div className="dots"><span/><span/><span/></div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              <div className="input-bar">
                <textarea ref={inputRef} className="chat-input" rows={1} dir={dir}
                  placeholder={t.inputPlaceholder(userName)}
                  value={input} onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
                <button className="mic-btn" onClick={listening ? stopVoice : startVoice}
                  title={dir==="rtl" ? "הקלטה קולית" : "Voice input"}
                  style={listening ? {background:"var(--accent)",color:"white",animation:"pulse-mic 1s ease-in-out infinite"} : {}}>
                  {listening ? <StopIcon size={16} /> : <MicIcon size={16} />}
                </button>
                <button className="send-btn" onClick={() => send()} disabled={!input.trim() || busy}>
                  <SendIcon size={16} rtl={isRtl} />
                </button>
              </div>
            </>
          )}

          {tab === "tasks" && (
            <TasksView tasks={tasks} user={user} lang={lang} onToggle={toggleTask} onClaim={claimTask} onDelete={deleteItem} onClearDone={clearDone} t={t} pendingDelete={pendingDelete} loading={!dataLoaded} />
          )}

          {tab === "shopping" && (
            <ShoppingView shopping={shopping} onToggle={toggleShop} onDelete={deleteItem} onClearGot={clearGot} t={t} pendingDelete={pendingDelete} loading={!dataLoaded} />
          )}

          {tab === "week" && (
            <WeekView tasks={tasks} events={events} rotations={rotations} t={t} lang={lang} onDeleteEvent={deleteEventHandler} />
          )}

        </div>

        {/* ── Bottom Nav ── */}
        <div className="bottom-nav">
          <button className={`nav-btn ${tab==="chat"?"active":""}`} onClick={() => setTab("chat")}>
            <span className="nav-icon"><ChatIcon size={20} /></span>
            <span className="nav-label">{t.navChat}</span>
          </button>
          <button className={`nav-btn ${tab==="tasks"?"active":""}`} onClick={() => setTab("tasks")}>
            <span className="nav-icon"><TasksIcon size={20} /></span>
            <span className="nav-label">{t.navTasks}</span>
            {openTasks > 0 && <span className="nav-badge">{openTasks}</span>}
          </button>
          <button className={`nav-btn ${tab==="shopping"?"active":""}`} onClick={() => setTab("shopping")}>
            <span className="nav-icon"><ShoppingIcon size={20} /></span>
            <span className="nav-label">{t.navShopping}</span>
            {neededItems > 0 && <span className="nav-badge">{neededItems}</span>}
          </button>
          <button className={`nav-btn ${tab==="week"?"active":""}`} onClick={() => setTab("week")}>
            <span className="nav-icon"><WeekIcon size={20} /></span>
            <span className="nav-label">{t.navWeek}</span>
          </button>
        </div>

      </div>
    </>
  );
}
