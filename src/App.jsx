import { useState, useEffect, useRef } from "react";
import T from "./locales/index.js";
import "./styles/app.css";
import { supabase, sbGet, sbSet, lsGet, lsSet, uid8, loadHousehold, saveTask, saveShoppingItem, saveEvent, deleteTask, deleteShoppingItem, deleteEvent, clearDoneTasks, clearGotShopping, saveAllTasks, saveAllShopping, saveAllEvents } from "./lib/supabase.js";
import buildPrompt from "./lib/prompt.js";
import Setup from "./components/Setup.jsx";
import AuthScreen from "./components/AuthScreen.jsx";
import WelcomeScreen from "./components/WelcomeScreen.jsx";
import { useAuth } from "./hooks/useAuth.js";
import TasksView from "./components/TasksView.jsx";
import ShoppingView from "./components/ShoppingView.jsx";
import WeekView from "./components/WeekView.jsx";
import MenuPanel from "./components/modals/MenuPanel.jsx";
import { ChatIcon, TasksIcon, ShoppingIcon, WeekIcon, MicIcon, StopIcon, SendIcon, VoiceWaveIcon } from "./components/Icons.jsx";
import JoinOrCreate from "./components/JoinOrCreate.jsx";
import { detectHousehold, joinByCode } from "./lib/household-detect.js";

const SHELI_PHONE = "972555175553";
const SHELI_WA_LINK = `https://wa.me/${SHELI_PHONE}?text=${encodeURIComponent("שלום שלי")}`;
const SHELI_PHONE_DISPLAY = "+972 55-517-5553";

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
  const [input, setInput]         = useState("");
  const [busy, setBusy]           = useState(false);
  const [showMenu, setShowMenu]   = useState(false);
  const [theme, setTheme]         = useState(() => lsGet("sheli-theme") || "auto");
  const isFounder = !!lsGet("sheli-founder");
  const { session, user: authUser, profile, loading: authLoading, signOut } = useAuth();
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const t   = T[lang] || T.en;
  const dir = t.dir;
  const msgs = user ? (allMsgs[user.id] || []) : [];
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

    if (!session) {
      setScreen("welcome");
      return;
    }

    // Authenticated → proceed with household loading (with 8s global timeout)
    const bootAsync = async () => {
      const params = new URLSearchParams(window.location.search);
      const joinId = params.get("join");
      console.log("[Boot] Starting async boot. joinId:", joinId, "hhId:", lsGet("sheli-hhid"));

      // Helper: load from BOTH old blob AND new tables, merge results
      // WhatsApp bot writes to new tables; web app chat writes to old blob
      // We need data from both sources until fully migrated
      const loadData = async (id) => {
        let oldData = null;
        let v2Data = null;

        const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
        try { oldData = await withTimeout(sbGet(id), 4000); } catch (e) { console.warn("[Boot] sbGet:", e.message); }
        try { v2Data = await withTimeout(loadHousehold(id), 4000); } catch (e) { console.warn("[Boot] loadHousehold:", e.message); }

        console.log("[Boot] oldData:", oldData ? JSON.stringify({tasks: oldData.tasks?.length, shop: oldData.shopping?.length, hhName: oldData.hh?.name}) : "null");
        console.log("[Boot] v2Data:", v2Data ? JSON.stringify({tasks: v2Data.tasks?.length, shop: v2Data.shopping?.length, hhName: v2Data.hh?.name}) : "null");
        console.log("[Boot] hhId used:", lsGet("sheli-hhid"));

        if (!oldData && !v2Data) return null;

        // Merge: use old blob for household info (has members with old IDs),
        // but combine tasks/shopping/events from BOTH sources (deduplicate by ID)
        const hh = oldData?.hh || v2Data?.hh;
        if (!hh) return null;

        // If v2 has members, prefer those (auto-learned from WhatsApp)
        if (v2Data?.hh?.members?.length > 0) {
          hh.members = v2Data.hh.members;
        }

        // Merge arrays by ID (deduplicate)
        const mergeById = (arr1, arr2) => {
          const map = new Map();
          for (const item of (arr1 || [])) map.set(item.id, item);
          for (const item of (arr2 || [])) map.set(item.id, item);
          return Array.from(map.values());
        };

        // Normalize v2 tasks from snake_case to camelCase (DB uses assigned_to, app uses assignedTo)
        const normalizeTask = (t) => ({
          id: t.id, title: t.title, done: t.done,
          assignedTo: t.assignedTo || t.assigned_to || null,
          completedBy: t.completedBy || t.completed_by || null,
          completedAt: t.completedAt || t.completed_at || null,
        });
        const normalizeEvent = (e) => ({
          id: e.id, title: e.title,
          assignedTo: e.assignedTo || e.assigned_to || null,
          scheduledFor: e.scheduledFor || e.scheduled_for || null,
        });

        const oldTasks = (oldData?.tasks || []).map(normalizeTask);
        const v2Tasks = (v2Data?.tasks || []).map(normalizeTask);
        const oldEvents = (oldData?.events || []).map(normalizeEvent);
        const v2Events = (v2Data?.events || []).map(normalizeEvent);

        const merged = {
          hh,
          tasks: mergeById(oldTasks, v2Tasks),
          shopping: mergeById(oldData?.shopping, v2Data?.shopping),
          events: mergeById(oldEvents, v2Events),
        };
        console.log("[Boot] Merged:", `tasks:${merged.tasks.length} shop:${merged.shopping.length} events:${merged.events.length}`);
        return merged;
      };

      if (joinId) {
        try {
          const data = await loadData(joinId);
          if (data) {
            setHouseholdS(data.hh); setLang(data.hh.lang || "en");
            setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []);
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
            setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []);
            const msgs = lsGet("sheli-msgs") || {};
            setAllMsgs(msgs);
            const savedUser = lsGet("sheli-user");
            if (savedUser) {
              const stillExists = data.hh.members.find(m => m.id === savedUser.id)
                || data.hh.members.find(m => m.name === savedUser.name);
              if (stillExists) {
                setUser(stillExists);
                lsSet("sheli-user", stillExists);
                setScreen("chat"); return;
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
          detectHousehold(session.user.id, session.user.email),
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
              setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []);
            }
          }).catch(e => console.warn("[Boot] Background load:", e));
          return;
        }
      } catch (e) { console.warn("[Boot] Auto-detect error:", e); }

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

  useEffect(() => {
    if (screen !== "chat") return;
    const hhId = lsGet("sheli-hhid");
    if (!hhId) return;

    // Listen on OLD households table (backward compat)
    const oldChannel = supabase
      .channel(`household-old-${hhId}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "households",
        filter: `id=eq.${hhId}`,
      }, (payload) => {
        if (Date.now() - lastSaveRef.current < 3000) return;
        const d = payload.new?.data;
        if (!d) return;
        if (d.tasks)    setTasksS(d.tasks);
        if (d.shopping) setShoppingS(d.shopping);
        if (d.events)   setEventsS(d.events);
        if (d.hh)       setHouseholdS(d.hh);
      })
      .subscribe();

    // Listen on NEW normalized tables (WhatsApp bot writes here)
    const reloadFromTables = async () => {
      if (Date.now() - lastSaveRef.current < 3000) return;
      const v2 = await loadHousehold(hhId);
      if (v2) {
        setTasksS(v2.tasks);
        setShoppingS(v2.shopping);
        setEventsS(v2.events);
      }
    };

    const tasksChannel = supabase
      .channel(`tasks-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `household_id=eq.${hhId}` }, reloadFromTables)
      .subscribe();

    const shoppingChannel = supabase
      .channel(`shopping-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items", filter: `household_id=eq.${hhId}` }, reloadFromTables)
      .subscribe();

    const eventsChannel = supabase
      .channel(`events-${hhId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `household_id=eq.${hhId}` }, reloadFromTables)
      .subscribe();

    return () => {
      supabase.removeChannel(oldChannel);
      supabase.removeChannel(tasksChannel);
      supabase.removeChannel(shoppingChannel);
      supabase.removeChannel(eventsChannel);
    };
  }, [screen]);

  // ── Persist (writes to BOTH old JSON blob AND new normalized tables) ──
  const save = async (hh, m, tk, sh, ev) => {
    const hhId = lsGet("sheli-hhid");
    if (!hhId) return;
    lastSaveRef.current = Date.now();

    // Write to old JSON blob (backward compat for existing households)
    const current = {
      hh:       hh !== undefined ? hh : householdRef.current,
      tasks:    tk !== undefined ? tk : tasksRef.current,
      shopping: sh !== undefined ? sh : shoppingRef.current,
      events:   ev !== undefined ? ev : eventsRef.current,
    };
    await sbSet(hhId, current);

    // Also write to normalized tables (so WhatsApp bot sees changes)
    try {
      if (tk !== undefined) await saveAllTasks(hhId, tk);
      if (sh !== undefined) await saveAllShopping(hhId, sh);
      if (ev !== undefined) await saveAllEvents(hhId, ev);
    } catch (err) {
      console.error("[save] Normalized table write error:", err);
    }

    if (m !== undefined) lsSet("sheli-msgs", m);
  };

  // ── Setup done ──
  const setupRunning = useRef(false);
  const handleSetup = async (hh) => {
    if (setupRunning.current) return; // prevent double-click
    setupRunning.current = true;
    console.log("[Setup] Starting...", hh.name, hh.members.length, "members");

    const hhId = uid8();
    hh.id = hhId;
    lsSet("sheli-hhid", hhId);
    lsSet("sheli-founder", true);

    // Navigate immediately — don't wait for DB writes
    setHouseholdS(hh); setLang(hh.lang || "en");
    setTasksS([]); setShoppingS([]); setEventsS([]);
    // Auto-select founder as current user (skip picker)
    const founder = hh.members[0];
    if (founder) {
      lsSet("sheli-user", founder);
      setUser(founder);
    }
    setScreen("connect-wa");

    // Write to DB in background (non-blocking)
    sbSet(hhId, { hh, tasks: [], shopping: [], events: [] }).catch(e => console.warn("[Setup] blob:", e));
    supabase.from("households_v2").upsert({ id: hhId, name: hh.name, lang: hh.lang || "he" }).catch(e => console.warn("[Setup] v2:", e));
    for (const member of hh.members) {
      supabase.from("household_members").insert({ household_id: hhId, display_name: member.name, role: "member" }).catch(e => console.warn("[Setup] member:", e));
    }
  };

  // ── Reset ──
  const doReset = async () => {
    const hhId = lsGet("sheli-hhid");
    if (hhId) {
      try {
        await supabase.from("households").delete().eq("id", hhId);
        await supabase.from("households_v2").delete().eq("id", hhId);
      } catch {}
    }
    localStorage.removeItem("sheli-hhid");
    localStorage.removeItem("sheli-msgs");
    localStorage.removeItem("sheli-user");
    localStorage.removeItem("sheli-founder");
    localStorage.removeItem("sheli-onboarded");
    setHousehold(null); setUser(null); setAllMsgs({}); setTasksS([]); setShoppingS([]); setEventsS([]); setInput("");
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
    save(updatedHh, undefined, undefined, undefined).catch(() => {});
  };

  const handleRenameHousehold = async (newName) => {
    if (!newName || !household) return;
    const updatedHh = { ...household, name: newName };
    setHouseholdS(updatedHh);
    save(updatedHh, undefined, undefined, undefined).catch(() => {});
    supabase.from("households_v2").update({ name: newName }).eq("id", household.id).catch(() => {});
  };

  const handleAddMember = async (name) => {
    if (!name || !household) return;
    const newMember = { id: uid8(), name };
    const updatedHh = { ...household, members: [...household.members, newMember] };
    setHouseholdS(updatedHh);
    save(updatedHh, undefined, undefined, undefined).catch(() => {});
    supabase.from("household_members").insert({ household_id: household.id, display_name: name, role: "member" }).catch(() => {});
  };

  const handleRemoveMember = async (memberId) => {
    if (!household) return;
    const updatedHh = { ...household, members: household.members.filter(m => m.id !== memberId) };
    setHouseholdS(updatedHh);
    save(updatedHh, undefined, undefined, undefined).catch(() => {});
    // Also delete from normalized table
    supabase.from("household_members").delete().eq("id", memberId).eq("household_id", household.id).catch(() => {});
  };

  // ── Language switch ──
  const switchLang = async (l) => {
    setLang(l);
    if (household) {
      const updated = { ...household, lang: l };
      setHouseholdS(updated);
      save(updated, undefined, undefined, undefined).catch(() => {});
    }
  };

  // ── Toggle/delete ──
  const toggleTask = async (id) => {
    const n = tasks.map(x => {
      if (x.id !== id) return x;
      const nowDone = !x.done;
      return { ...x, done: nowDone, completedBy: nowDone ? user.name : null, completedAt: nowDone ? new Date().toISOString() : null };
    });
    setTasksS(n); await save(undefined, undefined, n, undefined);
  };
  const claimTask = async (id, name) => {
    const n = tasks.map(x => x.id === id ? { ...x, assignedTo: name } : x);
    setTasksS(n); await save(undefined, undefined, n, undefined);
  };
  const toggleShop = async (id) => { const n = shopping.map(x => x.id===id ? {...x,got:!x.got} : x); setShoppingS(n); await save(undefined,undefined,undefined,n); };
  const deleteItem = async (type, id) => {
    if (type === "task") { const n = tasks.filter(x => x.id!==id); setTasksS(n); await save(undefined,undefined,n,undefined); }
    else { const n = shopping.filter(x => x.id!==id); setShoppingS(n); await save(undefined,undefined,undefined,n); }
  };
  const clearDone = async () => { const n = tasks.filter(x => !x.done); setTasksS(n); await save(undefined,undefined,n,undefined,undefined); };
  const clearGot  = async () => { const n = shopping.filter(x => !x.got); setShoppingS(n); await save(undefined,undefined,undefined,n,undefined); };
  const deleteEvent = async (id) => { const n = events.filter(x => x.id !== id); setEventsS(n); await save(undefined,undefined,undefined,undefined,n); };

  // ── Send ──
  const send = async (text) => {
    const content = (text || input).trim();
    if (!content || busy || !user) return;
    const uMsg = { role:"user", content, ts: Date.now() };
    const prev = allMsgs[user.id] || [];
    const updated = [...prev, uMsg];
    const nextAll = { ...allMsgs, [user.id]: updated };
    setAllMsgs(nextAll); setInput(""); setBusy(true); setTab("chat");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1200,
          system: buildPrompt(household, tasks, shopping, events, user, lang),
          messages: updated.slice(-20).map(m => ({ role: m.role, content: m.content })),
        })
      });
      const data = await res.json();
      const raw = (data.content?.[0]?.text || "{}").replace(/```json\n?|```/g,"").trim();
      let parsed = { message: t.genericError, tasks, shopping };
      try { parsed = JSON.parse(raw); } catch { parsed.message = raw || parsed.message; }

      const aMsg = { role:"assistant", content: parsed.message, ts: Date.now() };
      const finalMsgs = [...updated, aMsg];
      const finalAll  = { ...nextAll, [user.id]: finalMsgs };
      // Merge AI response with current state — don't let empty arrays wipe existing data
      const mergeLists = (aiList, current) => {
        if (!Array.isArray(aiList)) return current;
        if (aiList.length === 0 && current.length > 0) return current; // AI didn't touch this list
        // Merge by ID: AI items win, keep any current items the AI didn't mention
        const aiIds = new Set(aiList.map(x => x.id));
        const kept = current.filter(x => !aiIds.has(x.id) && x.id);
        return [...aiList, ...kept];
      };
      const newTasks  = mergeLists(parsed.tasks, tasks);
      const newShop   = mergeLists(parsed.shopping, shopping);
      const newEvents = mergeLists(parsed.events, events);
      setAllMsgs(finalAll); setTasksS(newTasks); setShoppingS(newShop); setEventsS(newEvents);
      await save(undefined, finalAll, newTasks, newShop, newEvents);
    } catch {
      const aMsg = { role:"assistant", content: t.networkError, ts: Date.now() };
      setAllMsgs({ ...nextAll, [user.id]: [...updated, aMsg] });
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
  if (screen === "loading") return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"var(--cream)",gap:8}}>
      <div style={{fontFamily:"'Cormorant Garamond',serif",fontWeight:300,fontSize:28,letterSpacing:"0.22em",color:"var(--dark)",opacity:0.6}}>Sheli</div>
      <div style={{fontSize:13,color:"var(--muted)",fontWeight:300}}>
        {T.en.loading}
      </div>
    </div>
  );

  if (screen === "welcome") return (
    <WelcomeScreen
      key="welcome-screen"
      onGetStarted={() => setScreen("auth")}
      onSignIn={() => setScreen("auth")}
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
    const wFont = wDir === "rtl" ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";
    const wt = T[household?.lang || "en"] || T.en;
    return (
      <div style={{minHeight:"100dvh",background:"var(--cream)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px",fontFamily:wFont,textAlign:"center"}} dir={wDir}>
        <div style={{fontSize:48,marginBottom:16}}>💬</div>
        <div style={{fontSize:20,fontWeight:500,color:"var(--dark)",marginBottom:12}}>{wt.waTitle}</div>
        <p style={{fontSize:14,color:"var(--muted)",fontWeight:400,lineHeight:1.65,maxWidth:300,marginBottom:24}}>{wt.waSub}</p>
        <div style={{background:"var(--white)",border:"1.5px solid var(--border)",borderRadius:16,padding:"20px 24px",marginBottom:24,width:"100%",maxWidth:300}}>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:8}}>{wt.waStep1}</div>
          <div style={{fontSize:18,fontWeight:600,color:"var(--dark)",marginBottom:16,letterSpacing:"0.03em",fontFamily:"'DM Sans',sans-serif",direction:"ltr"}}>{SHELI_PHONE_DISPLAY}</div>
          <div style={{fontSize:13,color:"var(--muted)"}}>{wt.waStep2}</div>
        </div>
        <a href={SHELI_WA_LINK} target="_blank" rel="noopener noreferrer"
          style={{display:"block",padding:"14px 36px",borderRadius:999,background:"#25D366",color:"#fff",border:"none",fontSize:15,fontWeight:500,cursor:"pointer",fontFamily:"inherit",textDecoration:"none",marginBottom:16,transition:"opacity 0.2s"}}>
          {wt.waBtn}
        </a>
        <button onClick={() => { lsSet("sheli-onboarded", true); setScreen(user ? "chat" : "pick"); }}
          style={{background:"none",border:"none",color:"var(--muted)",fontSize:14,cursor:"pointer",fontFamily:"inherit",padding:8}}>
          {wt.waLater}
        </button>
      </div>
    );
  }

  // ── User picker screen ──
  if (screen === "pick") {
    const pickDir = (household?.lang || "en") === "he" ? "rtl" : "ltr";
    const pickFont = pickDir === "rtl" ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";
    return (
      <div style={{minHeight:"100dvh",background:"var(--cream)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px",fontFamily:pickFont}} dir={pickDir}>
        <div style={{fontFamily:"'Cormorant Garamond',serif",fontWeight:300,fontSize:36,letterSpacing:"0.22em",color:"var(--dark)",marginBottom:6}}>Sheli</div>
        <p style={{fontSize:15,color:"var(--dark)",fontWeight:400,marginBottom:4,textAlign:"center"}}>
          {pickDir === "rtl"
            ? `ברוכים הבאים, ${household.name}`
            : `Welcome, ${household.name}`}
        </p>
        <p style={{fontSize:13,color:"var(--muted)",fontWeight:300,marginBottom:36}}>
          {pickDir === "rtl" ? "איך קוראים לך?" : "Who are you?"}
        </p>
        <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%",maxWidth:280}}>
          {household.members.map(m => (
            <button key={m.id}
              style={{padding:"15px 20px",borderRadius:14,border:"1.5px solid var(--border)",background:"var(--white)",fontFamily:pickFont,fontSize:16,fontWeight:500,color:"var(--dark)",cursor:"pointer",transition:"all 0.15s",boxShadow:"var(--sh)"}}
              onMouseOver={e=>e.currentTarget.style.borderColor="var(--accent)"}
              onMouseOut={e=>e.currentTarget.style.borderColor="var(--border)"}
              onClick={() => {
                if (!lsGet("sheli-hhid") && household?.id) {
                  lsSet("sheli-hhid", household.id);
                }
                // Data is already loaded and merged in state — no need to reload
                // Just restore messages from localStorage and set the user
                const msgs = lsGet("sheli-msgs") || {};
                setAllMsgs(msgs);
                lsSet("sheli-user", m);
                setUser(m);
                setScreen("chat");
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
          onClose={() => setShowMenu(false)}
          onRenameUser={handleRenameUser}
          onRenameHousehold={handleRenameHousehold}
          onAddMember={handleAddMember}
          onRemoveMember={handleRemoveMember}
          onSwitchLang={switchLang}
          onSetTheme={setTheme}
          onSwitchUser={() => { setShowMenu(false); setUser(null); lsSet("sheli-user", null); setScreen("pick"); }}
          onSignOut={async () => { await signOut(); setShowMenu(false); setScreen("welcome"); }}
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
            <div className="wordmark">Sheli</div>
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
            <TasksView tasks={tasks} user={user} lang={lang} onToggle={toggleTask} onClaim={claimTask} onDelete={deleteItem} onClearDone={clearDone} t={t} />
          )}

          {tab === "shopping" && (
            <ShoppingView shopping={shopping} onToggle={toggleShop} onDelete={deleteItem} onClearGot={clearGot} t={t} />
          )}

          {tab === "week" && (
            <WeekView tasks={tasks} events={events} t={t} lang={lang} onDeleteEvent={deleteEvent} />
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
