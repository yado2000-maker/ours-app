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
import LangModal from "./components/modals/LangModal.jsx";
import { ChatIcon, TasksIcon, ShoppingIcon, WeekIcon, SettingsIcon, ShareIcon, CheckmarkIcon, MicIcon, StopIcon, SendIcon, VoiceWaveIcon } from "./components/Icons.jsx";
import JoinOrCreate from "./components/JoinOrCreate.jsx";
import { detectHousehold, joinByCode } from "./lib/household-detect.js";

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function Ours() {
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
  const [showReset, setShowReset] = useState(false);
  const [showLang, setShowLang]   = useState(false);
  const [copied, setCopied]       = useState(false);
  const [theme, setTheme]         = useState(() => lsGet("ours-theme") || "auto");
  const [editName, setEditName]   = useState("");
  const isFounder = !!lsGet("ours-founder");
  const { session, user: authUser, profile, loading: authLoading, signOut } = useAuth();
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const t   = T[lang] || T.en;
  const dir = t.dir;
  const msgs = user ? (allMsgs[user.id] || []) : [];
  const isRtl = dir === "rtl";

  // ── Boot (runs ONCE when auth resolves) ──
  const bootedRef = useRef(false);

  // Safety: if auth never resolves, force welcome after 3 seconds
  useEffect(() => {
    const safety = setTimeout(() => {
      if (!bootedRef.current) {
        console.warn("[Boot] Auth timeout — forcing welcome");
        bootedRef.current = true;
        setScreen("welcome");
      }
    }, 3000);
    return () => clearTimeout(safety);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (bootedRef.current) return;
    bootedRef.current = true;

    if (!session) {
      setScreen("welcome");
      return;
    }

    // Authenticated → proceed with household loading
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const joinId = params.get("join");

      // Helper: load from BOTH old blob AND new tables, merge results
      // WhatsApp bot writes to new tables; web app chat writes to old blob
      // We need data from both sources until fully migrated
      const loadData = async (id) => {
        let oldData = null;
        let v2Data = null;

        try { oldData = await sbGet(id); } catch (e) { console.warn("[Boot] sbGet:", e); }
        try { v2Data = await loadHousehold(id); } catch (e) { console.warn("[Boot] loadHousehold:", e); }

        console.log("[Boot] oldData:", oldData ? JSON.stringify({tasks: oldData.tasks?.length, shop: oldData.shopping?.length, hhName: oldData.hh?.name}) : "null");
        console.log("[Boot] v2Data:", v2Data ? JSON.stringify({tasks: v2Data.tasks?.length, shop: v2Data.shopping?.length, hhName: v2Data.hh?.name}) : "null");
        console.log("[Boot] hhId used:", lsGet("ours-hhid"));

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
      const hhId = lsGet("ours-hhid");
      if (hhId) {
        try {
          const data = await loadData(hhId);
          if (data) {
            setHouseholdS(data.hh); setLang(data.hh.lang || "en");
            setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []);
            const msgs = lsGet("ours-msgs") || {};
            setAllMsgs(msgs);
            const savedUser = lsGet("ours-user");
            if (savedUser) {
              const stillExists = data.hh.members.find(m => m.id === savedUser.id)
                || data.hh.members.find(m => m.name === savedUser.name);
              if (stillExists) {
                setUser(stillExists);
                lsSet("ours-user", stillExists);
                setScreen("chat"); return;
              }
            }
            setScreen("pick"); return;
          }
        } catch (e) { console.error("[Boot] Household load error:", e); }
      }

      // No household in localStorage — try auto-detect
      console.log("[Boot] No hhId, running auto-detect...");
      try {
        const detected = await detectHousehold(session.user.id, session.user.email);
        if (detected) {
          console.log("[Boot] Auto-detected household:", detected.name, detected.id);
          // Auto-join: load the detected household directly
          lsSet("ours-hhid", detected.id);
          const data = await loadData(detected.id);
          if (data) {
            setHouseholdS(data.hh); setLang(data.hh.lang || "en");
            setTasksS(data.tasks || []); setShoppingS(data.shopping || []); setEventsS(data.events || []);
            setScreen("pick"); return;
          }
          // If load failed, still show join-or-create with detected info
          setDetectedHh(detected);
        }
      } catch (e) { console.warn("[Boot] Auto-detect error:", e); }

      // Show join-or-create screen (with or without detected household)
      setScreen("join-or-create");
    })();

  }, [authLoading, session]); // session in deps so it runs when auth completes, but bootedRef prevents re-runs

  // ── Theme ──
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    lsSet("ours-theme", theme);
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
    const hhId = lsGet("ours-hhid");
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
    const hhId = lsGet("ours-hhid");
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

    if (m !== undefined) lsSet("ours-msgs", m);
  };

  // ── Setup done ──
  const handleSetup = async (hh) => {
    const hhId = uid8();
    hh.id = hhId;
    lsSet("ours-hhid", hhId);
    lsSet("ours-founder", true);

    // Write to old JSON blob
    await sbSet(hhId, { hh, tasks: [], shopping: [], events: [] });

    // Also create in normalized tables
    try {
      await supabase.from("households_v2").upsert({ id: hhId, name: hh.name, lang: hh.lang || "he" });
      for (const member of hh.members) {
        await supabase.from("household_members").insert({
          household_id: hhId,
          display_name: member.name,
          role: "member",
        });
      }
    } catch (err) {
      console.error("[handleSetup] Normalized table error:", err);
    }

    setHouseholdS(hh); setLang(hh.lang || "en");
    setTasksS([]); setShoppingS([]); setEventsS([]);
    setScreen("pick");
  };

  // ── Reset ──
  const SB_URL = "https://wzwwtghtnkapdwlgnrxr.supabase.co";
  const SB_KEY = "sb_publishable_w5_9MXaM2XAZRk2b8rquoQ_kFpcUMTA";

  const doReset = async () => {
    const hhId = lsGet("ours-hhid");
    if (hhId) {
      try {
        await fetch(`${SB_URL}/rest/v1/households?id=eq.${hhId}`, {
          method: "DELETE",
          headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` }
        });
      } catch {}
    }
    localStorage.removeItem("ours-hhid");
    localStorage.removeItem("ours-msgs");
    localStorage.removeItem("ours-user");
    setHousehold(null); setUser(null); setAllMsgs({}); setTasksS([]); setShoppingS([]); setEventsS([]); setInput("");
    setShowReset(false); setScreen("setup");
  };

  const [shareUrl, setShareUrl] = useState(null);

  // ── Rename user ──
  const renameUser = async () => {
    const newName = editName.trim();
    if (!newName || newName === user.name) { setShowReset(false); return; }
    const updatedMembers = household.members.map(m =>
      m.id === user.id ? { ...m, name: newName } : m
    );
    const updatedHh = { ...household, members: updatedMembers };
    const updatedUser = { ...user, name: newName };
    setHouseholdS(updatedHh);
    setUser(updatedUser);
    lsSet("ours-user", updatedUser);
    await save(updatedHh, undefined, undefined, undefined);
    setShowReset(false);
  };

  // ── Share join link ──
  const shareLink = () => {
    const hhId = lsGet("ours-hhid") || household?.id;
    if (!hhId) return;
    const url = `${window.location.origin}/?join=${hhId}`;
    setShareUrl(url);
  };

  // ── Language switch ──
  const switchLang = async (l) => {
    setLang(l); setShowLang(false);
    if (household) {
      const updated = { ...household, lang: l };
      setHouseholdS(updated);
      await save(updated, undefined, undefined, undefined);
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
      const newTasks  = Array.isArray(parsed.tasks)    ? parsed.tasks    : tasks;
      const newShop   = Array.isArray(parsed.shopping) ? parsed.shopping : shopping;
      const newEvents = Array.isArray(parsed.events)   ? parsed.events   : events;
      setAllMsgs(finalAll); setTasksS(newTasks); setShoppingS(newShop); setEventsS(newEvents);
      await save(undefined, finalAll, newTasks, newShop, newEvents);
    } catch {
      const aMsg = { role:"assistant", content: t.networkError, ts: Date.now() };
      setAllMsgs({ ...nextAll, [user.id]: [...updated, aMsg] });
    }
    setBusy(false);
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
      <div style={{fontFamily:"'Cormorant Garamond',serif",fontWeight:300,fontSize:28,letterSpacing:"0.22em",color:"var(--dark)",opacity:0.6}}>Ours</div>
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
      onAuthSuccess={() => {}}
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
        lsSet("ours-hhid", info.id);
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

  if (screen === "setup") return <Setup onDone={handleSetup} />;

  // ── User picker screen ──
  if (screen === "pick") {
    const pickDir = (household?.lang || "en") === "he" ? "rtl" : "ltr";
    const pickFont = pickDir === "rtl" ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";
    return (
      <div style={{minHeight:"100dvh",background:"var(--cream)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px",fontFamily:pickFont}} dir={pickDir}>
        <div style={{fontFamily:"'Cormorant Garamond',serif",fontWeight:300,fontSize:36,letterSpacing:"0.22em",color:"var(--dark)",marginBottom:6}}>Ours</div>
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
              onClick={async () => {
                if (!lsGet("ours-hhid") && household?.id) {
                  lsSet("ours-hhid", household.id);
                }
                const hhId = lsGet("ours-hhid") || household?.id;
                if (hhId) {
                  try {
                    const data = await sbGet(hhId);
                    if (data) {
                      setTasksS(data.tasks || []);
                      setShoppingS(data.shopping || []);
                      setEventsS(data.events || []);
                    }
                  } catch {}
                }
                const msgs = lsGet("ours-msgs") || {};
                setAllMsgs(msgs);
                lsSet("ours-user", m);
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
      {/* Settings modal */}
      {showReset && (
        <div className="overlay" onClick={() => setShowReset(false)}>
          <div className="modal" dir={dir} onClick={e => e.stopPropagation()} style={{display:"flex",flexDirection:"column",gap:20,maxHeight:"85dvh",overflowY:"auto",fontFamily:dir==="rtl"?"'Heebo',sans-serif":"'DM Sans',sans-serif"}}>
            <div className="modal-title">{t.settingsTitle}</div>

            {/* Rename */}
            <div>
              <div className="section-head" style={{marginBottom:8}}>{t.settingsName}</div>
              <div style={{display:"flex",gap:8,flexDirection:dir==="rtl"?"row-reverse":"row"}}>
                <input
                  style={{flex:1,padding:"10px 13px",borderRadius:10,border:"1.5px solid var(--border)",background:"var(--cream)",fontFamily:"inherit",fontSize:14,color:"var(--dark)",outline:"none",textAlign:"start"}}
                  defaultValue={user.name}
                  onChange={e => setEditName(e.target.value)}
                  onFocus={e => setEditName(e.target.value)}
                  dir={dir}
                />
                <button onClick={renameUser}
                  style={{padding:"10px 16px",borderRadius:10,background:"var(--dark)",color:"var(--white)",border:"none",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>
                  {t.settingsSave}
                </button>
              </div>
            </div>

            {/* Theme */}
            <div>
              <div className="section-head" style={{marginBottom:8}}>{t.settingsTheme}</div>
              <div style={{display:"flex",gap:7}}>
                {[["light", t.themeLight], ["dark", t.themeDark], ["auto", t.themeAuto]].map(([val, label]) => (
                  <button key={val} onClick={() => setTheme(val)}
                    style={{flex:1,padding:"10px 6px",borderRadius:10,border:`1.5px solid ${theme===val?"var(--dark)":"var(--border)"}`,background:theme===val?"var(--dark)":"transparent",color:theme===val?"var(--white)":"var(--warm)",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Household info */}
            <div>
              <div className="section-head" style={{marginBottom:8}}>{dir === "rtl" ? "משק בית" : "Household"}</div>
              <div style={{padding:"10px 14px",borderRadius:10,background:"var(--cream)",border:"1px solid var(--border)",fontSize:13,color:"var(--warm)"}}>
                <div style={{fontWeight:500,color:"var(--dark)",marginBottom:2}}>{household?.name || ""}</div>
                <div style={{fontSize:12,color:"var(--muted)"}}>
                  {household?.members?.length || 0} {dir === "rtl" ? "חברים" : "members"}
                </div>
              </div>
            </div>

            {/* Sign out */}
            <button onClick={async () => { await signOut(); setShowReset(false); setScreen("welcome"); }}
              style={{padding:"11px 16px",borderRadius:10,background:"transparent",border:"1.5px solid var(--border)",color:"var(--warm)",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s",textAlign:"center"}}>
              {dir === "rtl" ? "התנתקות" : "Sign out"}
            </button>

            {/* Reset — founder only, small and understated */}
            {isFounder && (
              <div style={{paddingTop:8,borderTop:"1px solid var(--border)"}}>
                <button onClick={doReset}
                  style={{background:"none",border:"none",color:"var(--muted)",fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:4,opacity:0.6,transition:"opacity 0.15s"}}
                  onMouseOver={e => e.currentTarget.style.opacity = 1}
                  onMouseOut={e => e.currentTarget.style.opacity = 0.6}>
                  {dir === "rtl" ? "מחיקת כל הנתונים ואיפוס" : "Delete all data and reset"}
                </button>
              </div>
            )}

            {/* Close */}
            <button onClick={() => setShowReset(false)}
              style={{padding:"12px",borderRadius:10,background:"var(--cream)",border:"1.5px solid var(--border)",color:"var(--warm)",fontSize:14,fontWeight:500,cursor:"pointer",fontFamily:"inherit",textAlign:"center"}}>
              {dir === "rtl" ? "סגור" : "Close"}
            </button>
          </div>
        </div>
      )}

      {/* Lang switch modal */}
      {showLang && (
        <LangModal lang={lang} onSelect={switchLang} onClose={() => setShowLang(false)} />
      )}

      {/* Share modal */}
      {shareUrl && (
        <div className="overlay" onClick={() => setShareUrl(null)}>
          <div className="modal" dir={dir} onClick={e => e.stopPropagation()} style={{fontFamily:dir==="rtl"?"'Heebo',sans-serif":"'DM Sans',sans-serif"}}>
            <div className="modal-title">{dir === "rtl" ? "קישור הצטרפות" : "Join link"}</div>
            <p className="modal-sub">{dir === "rtl" ? "שלחו את הקישור הזה לבני המשפחה. כשייכנסו דרכו — הבית כבר מוגדר." : "Send this to your family. When they open it, the household is already set up."}</p>
            <div style={{background:"var(--cream)",borderRadius:10,padding:"11px 14px",fontSize:12,wordBreak:"break-all",color:"var(--warm)",marginBottom:16,userSelect:"all",border:"1px solid var(--border)"}}>
              {shareUrl}
            </div>
            <div className="modal-btns">
              <button className="modal-cancel" onClick={() => setShareUrl(null)}>
                {dir === "rtl" ? "סגור" : "Close"}
              </button>
              <a className="modal-confirm" style={{textDecoration:"none",display:"flex",alignItems:"center",justifyContent:"center"}}
                href={`https://wa.me/?text=${encodeURIComponent(shareUrl)}`} target="_blank" rel="noreferrer"
                onClick={() => setShareUrl(null)}>
                {dir === "rtl" ? "שתף בוואטסאפ ↗" : "Share on WhatsApp ↗"}
              </a>
            </div>
          </div>
        </div>
      )}

      <div className="app" dir={dir}>

        {/* ── Header ── */}
        <div className="header">
          <div className="header-side left">
            <button className="lang-chip" onClick={() => setShowLang(true)}>
              {lang === "he" ? "HE" : "EN"}
            </button>
          </div>
          <div className="header-mid">
            <div className="wordmark">Ours</div>
          </div>
          <div className="header-side right">
            <div style={{fontSize:13,fontWeight:500,color:"var(--warm)",paddingInlineEnd:4}}>{user.name}</div>
            <button className="icon-btn" onClick={() => setShowReset(true)} title={t.settingsTitle}><SettingsIcon size={18} /></button>
            <button className={`icon-btn`} onClick={shareLink}
              title={dir==="rtl" ? "שתפו קישור הצטרפות" : "Share join link"}
              style={copied ? {color:"var(--green)",opacity:1} : {}}>
              {copied ? <CheckmarkIcon size={16} /> : <ShareIcon size={18} />}
            </button>
          </div>
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
                      <div className="msg-label">{m.role==="user" ? userName : t.oursLabel}</div>
                      <div className="bubble">{m.content}</div>
                    </div>
                  ))
                )}
                {busy && (
                  <div className="msg-wrap thinking-wrap">
                    <div className="msg-label">{t.oursLabel}</div>
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
