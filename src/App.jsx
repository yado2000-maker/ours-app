import { useState, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// i18n — all UI strings
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  en: {
    dir: "ltr",
    loading: "Loading…",
    // setup
    langStep: "Choose your language",
    langEn: "English", langHe: "עברית",
    setupSub: "Set up in 30 seconds.",
    hhLabel: "What do you call home?",
    hhPlaceholder: "The Cohen Family",
    whoLabel: "Who's in the household?",
    whoSub: "Add everyone's names — each person picks theirs when they open the app.",
    addPlaceholder: "Add a name…",
    addBtn: "Add",
    goBtn: "Let's go →",
    // header
    settingsTitle: "Settings",
    settingsName: "Your name",
    settingsSave: "Save",
    settingsTheme: "Theme",
    themeLight: "Light", themeDark: "Dark", themeAuto: "Auto",
    settingsDanger: "Danger zone",
    // reset modal
    resetTitle: "Reset household?",
    resetSub: "Clears all messages, tasks, shopping, and household data. Can't be undone.",
    resetCancel: "Cancel",
    resetConfirm: "Reset everything",
    // nav
    navChat: "Chat", navTasks: "Tasks", navShopping: "Shopping",
    // chat empty
    hiName: (n) => `Hi ${n} 👋`,
    chatSub: "Tell me what needs doing, or what to pick up.",
    s1: "What chores still need doing?",
    s2: "Add milk, eggs and bread to the list",
    s3: (n) => `Add 'vacuum living room' for ${n}`,
    s4: "What's on the shopping list?",
    inputPlaceholder: (n) => `Message Ours as ${n}…`,
    oursLabel: "Ours",
    // tasks
    tasksTitle: "Chores & Tasks",
    clearDone: "Clear done",
    sectionTodo: (n) => `To do · ${n}`,
    sectionDone: (n) => `Done · ${n}`,
    tasksEmpty: "No tasks yet. Tell Ours what needs doing.",
    allDone: "All done for now ✓",
    takeIt: "I'll do it",
    doneBy: (n) => `Done by ${n}`,
    completedAt: (n, d) => `${n} · ${d}`,
    // shopping
    shopTitle: "Shopping List",
    clearCart: "Clear cart",
    inCart: (n) => `In cart · ${n}`,
    shopEmpty: "List is empty. Tell Ours what you need.",
    allInCart: "Everything's in the cart ✓",
    qtyLabel: (q) => `Qty: ${q}`,
    // categories
    cats: ["Produce","Dairy","Meat","Bakery","Pantry","Frozen","Drinks","Household","Health Store","Other"],
    // error
    networkError: "Network error — check your connection.",
    genericError: "Something went wrong — try again.",
  },
  he: {
    dir: "rtl",
    loading: "טוען…",
    langStep: "בחרו שפה",
    langEn: "English", langHe: "עברית",
    setupSub: "הגדרה תוך 30 שניות.",
    hhLabel: "איך קוראים לכם?",
    hhPlaceholder: "משפחת ישראלי, המשפחה שלנו, כל שם שתבחרו",
    whoLabel: "מי בבית?",
    whoSub: "הוסיפו את כל השמות — כל אחד יבחר את שלו בכניסה.",
    addPlaceholder: "הוסיפו שם…",
    addBtn: "הוסיפו",
    goBtn: "אפשר להתקדם ←",
    settingsTitle: "הגדרות",
    settingsName: "השם שלך",
    settingsSave: "שמור",
    settingsTheme: "ערכת צבעים",
    themeLight: "בהיר", themeDark: "כהה", themeAuto: "לפי המכשיר",
    settingsDanger: "אזור מסוכן",
    resetTitle: "לאפס את משק הבית?",
    resetSub: "ימחק את כל ההודעות, המשימות, הקניות והנתונים. לא ניתן לבטל.",
    resetCancel: "ביטול",
    resetConfirm: "אפסו הכל",
    navChat: "צ׳אט", navTasks: "משימות", navShopping: "קניות",
    hiName: (n) => `היי ${n} 👋`,
    chatSub: "תגידו לי מה צריך לעשות, או מה לקנות.",
    s1: "אילו מטלות עוד לא נעשו?",
    s2: "תוסיפו חלב, ביצים ולחם לרשימה",
    s3: (n) => `תוסיפו 'לשאוב אבק בסלון' בשביל ${n}`,
    s4: "מה יש ברשימת הקניות?",
    inputPlaceholder: (n) => `הודעה ל-Ours בתור ${n}…`,
    oursLabel: "Ours",
    tasksTitle: "מטלות ומשימות",
    clearDone: "נקו שבוצעו",
    sectionTodo: (n) => `לביצוע · ${n}`,
    sectionDone: (n) => `בוצע · ${n}`,
    tasksEmpty: "אין עדיין משימות. תגידו ל-Ours מה צריך לעשות.",
    allDone: "הכל בוצע לעכשיו ✓",
    takeIt: "אני לוקח/ת",
    doneBy: (n) => `בוצע על ידי ${n}`,
    completedAt: (n, d) => `${n} · ${d}`,
    shopTitle: "רשימת קניות",
    clearCart: "נקו עגלה",
    inCart: (n) => `בעגלה · ${n}`,
    shopEmpty: "הרשימה ריקה. תגידו ל-Ours מה צריך.",
    allInCart: "הכל בעגלה ✓",
    qtyLabel: (q) => `כמות: ${q}`,
    cats: ["פירות וירקות","חלב וביצים","בשר ודגים","מאפים","מזווה","מוצרים קפואים","משקאות","ניקוי ובית","מוצרים מחנות הטבע","אחר"],
    networkError: "שגיאת רשת — בדקו את החיבור.",
    genericError: "משהו השתבש — נסו שוב.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;1,400&family=DM+Sans:wght@300;400;500&family=Heebo:wght@300;400;500&display=swap');

*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
:root{
  --cream:#F5F0E8;--dark:#1C1A17;--warm:#3D3830;
  --accent:#C4714A;--accent-soft:rgba(196,113,74,0.1);
  --green:#4A7C59;--muted:#8A8070;--white:#fff;
  --border:rgba(28,26,23,0.1);
  --sh:0 1px 8px rgba(0,0,0,0.06);--shm:0 2px 18px rgba(0,0,0,0.09);
}
[data-theme="dark"]{
  --cream:#1A1814;--dark:#F0EBE0;--warm:#C8BFB0;
  --muted:#6A6258;--white:#242018;--border:rgba(240,235,224,0.1);
  --sh:0 1px 8px rgba(0,0,0,0.3);--shm:0 2px 18px rgba(0,0,0,0.4);
}
@media(prefers-color-scheme:dark){
  [data-theme="auto"]{
    --cream:#1A1814;--dark:#F0EBE0;--warm:#C8BFB0;
    --muted:#6A6258;--white:#242018;--border:rgba(240,235,224,0.1);
    --sh:0 1px 8px rgba(0,0,0,0.3);--shm:0 2px 18px rgba(0,0,0,0.4);
  }
}
html,body{height:100%;background:var(--cream);overflow:hidden;}
.app{display:flex;flex-direction:column;height:100dvh;max-width:480px;margin:0 auto;background:var(--cream);}
.app[dir="ltr"]{font-family:'DM Sans',sans-serif;}
.app[dir="rtl"]{font-family:'Heebo',sans-serif;}
.app[dir="rtl"] *{font-family:'Heebo',sans-serif;}
.app[dir="rtl"] .wordmark,.app[dir="ltr"] .wordmark{font-family:'Cormorant Garamond',serif!important;}

/* ── Header ── */
.header{background:var(--white);border-bottom:1px solid var(--border);padding:11px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-shrink:0;box-shadow:var(--sh);z-index:10;}
.wordmark{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:22px;letter-spacing:0.18em;color:var(--dark);user-select:none;flex-shrink:0;}
.header-mid{flex:1;display:flex;justify-content:center;}
.header-side{display:flex;align-items:center;gap:6px;min-width:80px;}
.header-side.right{justify-content:flex-end;}
.header-side.left{justify-content:flex-start;}
.user-pills{display:flex;gap:5px;overflow-x:auto;scrollbar-width:none;}
.user-pills::-webkit-scrollbar{display:none;}
.pill{padding:5px 13px;border-radius:100px;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:all 0.15s;border:1.5px solid var(--border);background:transparent;color:var(--warm);}
.pill.active{background:var(--dark);color:var(--white);border-color:var(--dark);}
.pill:hover:not(.active){border-color:var(--accent);color:var(--dark);}
.icon-btn{background:none;border:none;cursor:pointer;color:var(--muted);font-size:17px;padding:4px;opacity:0.55;transition:opacity 0.15s;flex-shrink:0;line-height:1;border-radius:8px;}
.icon-btn:hover{opacity:1;color:var(--accent);}
.lang-chip{font-size:11px;font-weight:600;letter-spacing:0.05em;color:var(--muted);border:1.5px solid var(--border);border-radius:100px;padding:3px 9px;cursor:pointer;transition:all 0.15s;background:transparent;}
.lang-chip:hover{border-color:var(--accent);color:var(--accent);}

/* ── Bottom Nav ── */
.bottom-nav{background:var(--white);border-top:1px solid var(--border);display:flex;flex-shrink:0;}
.nav-btn{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:9px 4px 11px;background:none;border:none;cursor:pointer;color:var(--muted);transition:color 0.15s;position:relative;}
.nav-btn.active{color:var(--dark);}
.nav-btn.active::after{content:'';position:absolute;top:0;left:22%;right:22%;height:2.5px;background:var(--accent);border-radius:0 0 3px 3px;}
.nav-icon{font-size:19px;line-height:1;}
.nav-label{font-size:10px;font-weight:500;letter-spacing:0.03em;}
.nav-badge{position:absolute;top:5px;right:calc(50% - 20px);background:var(--accent);color:white;border-radius:100px;font-size:9px;font-weight:700;padding:2px 5px;min-width:16px;text-align:center;line-height:1.2;}

/* ── Tab body ── */
.tab-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0;}

/* ── Messages ── */
.messages{flex:1;padding:18px 16px 8px;display:flex;flex-direction:column;gap:12px;}
.msg-wrap{display:flex;flex-direction:column;max-width:82%;animation:msgIn 0.22s ease;}
.msg-wrap.user{align-self:flex-end;align-items:flex-end;}
.msg-wrap.assistant{align-self:flex-start;align-items:flex-start;}
[dir="rtl"] .msg-wrap.user{align-self:flex-start;align-items:flex-start;}
[dir="rtl"] .msg-wrap.assistant{align-self:flex-end;align-items:flex-end;}
@keyframes msgIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.msg-label{font-size:10.5px;color:var(--muted);font-weight:400;margin-bottom:3px;letter-spacing:0.03em;}
.bubble{padding:10px 14px;border-radius:18px;font-size:14.5px;line-height:1.65;white-space:pre-wrap;}
.msg-wrap.user .bubble{background:var(--dark);color:var(--white);border-bottom-right-radius:4px;}
.msg-wrap.assistant .bubble{background:var(--white);color:var(--dark);border-bottom-left-radius:4px;box-shadow:var(--sh);}
[dir="rtl"] .msg-wrap.user .bubble{border-bottom-right-radius:18px;border-bottom-left-radius:4px;}
[dir="rtl"] .msg-wrap.assistant .bubble{border-bottom-left-radius:18px;border-bottom-right-radius:4px;}

/* dots */
.thinking-wrap{align-self:flex-start;}
[dir="rtl"] .thinking-wrap{align-self:flex-end;}
.dots{display:flex;gap:5px;padding:13px 15px;background:var(--white);border-radius:18px;border-bottom-left-radius:4px;box-shadow:var(--sh);}
.dots span{width:7px;height:7px;border-radius:50%;background:var(--muted);animation:dot 1.2s ease-in-out infinite;}
.dots span:nth-child(2){animation-delay:0.18s}.dots span:nth-child(3){animation-delay:0.36s}
@keyframes dot{0%,60%,100%{transform:translateY(0);opacity:0.35}30%{transform:translateY(-6px);opacity:1}}

/* empty */
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center;padding:28px 24px;}
.empty-hi{font-family:'Cormorant Garamond',serif;font-size:27px;font-weight:400;color:var(--dark);}
.empty-sub{font-size:13.5px;color:var(--muted);font-weight:300;line-height:1.65;max-width:240px;}
.starters{display:flex;flex-direction:column;gap:6px;margin-top:10px;width:100%;max-width:300px;}
.starter{padding:10px 15px;border-radius:12px;background:var(--white);border:1.5px solid var(--border);color:var(--warm);font-size:13px;cursor:pointer;text-align:start;transition:all 0.15s;font-weight:400;}
.starter:hover{border-color:var(--accent);color:var(--dark);background:var(--accent-soft);}

/* input bar */
.input-bar{background:var(--white);border-top:1px solid var(--border);padding:9px 11px;display:flex;gap:8px;align-items:flex-end;flex-shrink:0;}
.chat-input{flex:1;border:1.5px solid var(--border);border-radius:22px;padding:10px 15px;font-size:15px;color:var(--dark);background:var(--cream);outline:none;resize:none;max-height:110px;min-height:42px;line-height:1.5;transition:border-color 0.2s;font-weight:400;overflow-y:auto;text-align:start;}
.chat-input:focus{border-color:var(--accent);}
.chat-input::placeholder{color:var(--muted);font-weight:300;}
.send-btn{width:42px;height:42px;border-radius:50%;background:var(--dark);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.18s,transform 0.1s;color:white;font-size:17px;line-height:1;}
.send-btn:hover:not(:disabled){background:var(--accent);}
.send-btn:active:not(:disabled){transform:scale(0.92);}
.send-btn:disabled{opacity:0.3;cursor:not-allowed;}
.mic-btn{width:38px;height:38px;border-radius:50%;background:var(--cream);border:1.5px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.18s;font-size:15px;line-height:1;}
.mic-btn:hover{border-color:var(--accent);}
@keyframes pulse-mic{0%,100%{transform:scale(1)}50%{transform:scale(1.08);}}

/* ── List views ── */
.list-view{flex:1;overflow-y:auto;padding:14px 16px 20px;display:flex;flex-direction:column;gap:6px;}
.list-header{display:flex;align-items:center;justify-content:space-between;padding:4px 2px 10px;}
.list-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:400;color:var(--dark);}
.section-head{font-size:10.5px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);padding:10px 2px 4px;}
[dir="rtl"] .section-head{letter-spacing:0;}

/* task row */
.task-row{display:flex;align-items:center;gap:11px;background:var(--white);border-radius:13px;padding:12px 14px;box-shadow:var(--sh);border:1.5px solid var(--border);transition:opacity 0.25s,transform 0.15s;animation:rowIn 0.2s ease;}
@keyframes rowIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.task-row.done{opacity:0.4;}
.check-circle{width:22px;height:22px;border-radius:50%;border:2px solid var(--border);flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.18s;background:transparent;}
.check-circle.on{background:var(--green);border-color:var(--green);}
.check-circle svg{opacity:0;transition:opacity 0.14s;transform:scale(0.8);transition:opacity 0.14s,transform 0.14s;}
.check-circle.on svg{opacity:1;transform:scale(1);}
.task-text{flex:1;font-size:14.5px;color:var(--dark);font-weight:400;line-height:1.4;}
.task-col{flex:1;display:flex;flex-direction:column;gap:2px;}
.task-meta{font-size:11px;color:var(--green);font-weight:400;}
.task-row.done .task-text{text-decoration:line-through;color:var(--muted);}
.assignee-badge{font-size:11px;font-weight:500;color:var(--accent);background:var(--accent-soft);border-radius:100px;padding:3px 8px 3px 10px;white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:4px;}
.badge-x{background:none;border:none;cursor:pointer;color:var(--accent);font-size:13px;line-height:1;padding:0;opacity:0.6;transition:opacity 0.12s;}
.badge-x:hover{opacity:1;}
.completed-by-badge{font-size:11px;font-weight:500;color:var(--green);background:rgba(74,124,89,0.1);border-radius:100px;padding:3px 10px;white-space:nowrap;flex-shrink:0;}
.take-btn{font-size:11.5px;font-weight:500;color:var(--accent);background:var(--accent-soft);border:1.5px solid var(--accent-mid);border-radius:100px;padding:3px 11px;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all 0.15s;font-family:inherit;}
.take-btn:hover{background:var(--accent);color:white;}
.del-btn{background:none;border:none;cursor:pointer;color:var(--muted);opacity:0;font-size:16px;padding:2px 4px;transition:opacity 0.15s,color 0.15s;flex-shrink:0;line-height:1;}
.task-row:hover .del-btn,.shop-row:hover .del-btn{opacity:0.5;}
.del-btn:hover{opacity:1!important;color:#b33;}

/* shopping row */
.shop-row{display:flex;align-items:center;gap:11px;background:var(--white);border-radius:13px;padding:12px 14px;box-shadow:var(--sh);border:1.5px solid var(--border);transition:opacity 0.25s;animation:rowIn 0.2s ease;}
.shop-row.got{opacity:0.38;}
.shop-check{width:22px;height:22px;border-radius:6px;border:2px solid var(--border);flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.18s;background:transparent;}
.shop-check.on{background:var(--accent);border-color:var(--accent);}
.shop-check.on svg{opacity:1;transform:scale(1);}
.shop-check svg{opacity:0;transition:opacity 0.14s,transform 0.14s;transform:scale(0.8);}
.shop-text{flex:1;}
.shop-name{font-size:14.5px;color:var(--dark);font-weight:400;}
.shop-row.got .shop-name{text-decoration:line-through;color:var(--muted);}
.shop-qty{font-size:12px;color:var(--muted);margin-top:1px;font-weight:300;}
.cat-badge{font-size:11px;color:var(--muted);background:var(--cream);border:1px solid var(--border);border-radius:100px;padding:2px 8px;white-space:nowrap;flex-shrink:0;}

/* list empty */
.list-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:52px 24px;text-align:center;}
.list-empty-icon{font-size:38px;opacity:0.3;}
.list-empty-text{font-size:13.5px;color:var(--muted);font-weight:300;line-height:1.65;max-width:210px;}
.all-done-msg{text-align:center;padding:16px 0 6px;font-size:14px;color:var(--green);font-weight:400;}
.clear-btn{background:none;border:1.5px solid var(--border);border-radius:10px;padding:5px 12px;font-size:12px;color:var(--muted);cursor:pointer;transition:all 0.15s;}
.clear-btn:hover{border-color:var(--accent);color:var(--accent);}

/* ── Setup ── */
.setup-wrap{min-height:100dvh;background:var(--cream);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;overflow-y:auto;}
.setup-mark{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:38px;letter-spacing:0.22em;color:var(--dark);margin-bottom:4px;}
.setup-tagline{font-size:13px;color:var(--muted);font-weight:300;margin-bottom:36px;letter-spacing:0.03em;}
.setup-form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:20px;}
.step-label{font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-bottom:14px;text-align:center;}
[dir="rtl"] .step-label{letter-spacing:0;}

/* Language cards */
.lang-cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.lang-card{padding:18px 14px;border-radius:16px;border:2px solid var(--border);background:var(--white);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;transition:all 0.18s;box-shadow:var(--sh);}
.lang-card:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:var(--shm);}
.lang-card.selected{border-color:var(--dark);background:var(--dark);}
.lang-flag{font-size:22px;font-weight:700;letter-spacing:0.04em;line-height:1;color:var(--warm);font-family:'DM Sans',sans-serif;}
.lang-card.selected .lang-flag{color:var(--white);}
.lang-name{font-size:14px;font-weight:500;color:var(--warm);}
.lang-card.selected .lang-name{color:var(--white);}

/* Form fields */
.field{display:flex;flex-direction:column;gap:6px;}
.field-label{font-size:11.5px;font-weight:500;color:var(--warm);letter-spacing:0.05em;text-transform:uppercase;}
.field-sub{font-size:12.5px;color:var(--muted);font-weight:300;line-height:1.55;margin-top:2px;}
[dir="rtl"] .field-label{letter-spacing:0;}
.field-input{padding:13px 15px;border-radius:12px;border:1.5px solid var(--border);background:var(--white);font-size:15px;color:var(--dark);outline:none;transition:border-color 0.2s;text-align:start;}
.field-input:focus{border-color:var(--accent);}
.field-input::placeholder{color:var(--muted);font-weight:300;}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px;}
.tag{padding:5px 12px;border-radius:100px;background:var(--white);border:1.5px solid var(--border);font-size:13px;color:var(--warm);display:flex;align-items:center;gap:6px;}
.tag-x{background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;line-height:1;padding:0;}
.tag-x:hover{color:var(--accent);}
.add-row{display:flex;gap:7px;}
.add-input{flex:1;padding:11px 13px;border-radius:11px;border:1.5px solid var(--border);background:var(--white);font-size:14px;color:var(--dark);outline:none;transition:border-color 0.2s;text-align:start;}
.add-input:focus{border-color:var(--accent);}
.add-input::placeholder{color:var(--muted);font-weight:300;}
.add-mini{padding:11px 16px;border-radius:11px;background:var(--dark);color:var(--white);border:none;cursor:pointer;font-size:13px;font-weight:500;transition:background 0.15s;white-space:nowrap;}
.add-mini:hover{background:var(--accent);}
.go-btn{padding:15px;border-radius:14px;background:var(--dark);color:var(--white);border:none;cursor:pointer;font-size:15px;font-weight:500;transition:background 0.2s;margin-top:2px;}
.go-btn:hover:not(:disabled){background:var(--accent);}
.go-btn:disabled{opacity:0.3;cursor:not-allowed;}
.back-btn{background:none;border:none;cursor:pointer;color:var(--muted);font-size:13px;text-align:center;padding:4px;transition:color 0.15s;}
.back-btn:hover{color:var(--accent);}

/* ── Modal ── */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.42);z-index:50;display:flex;align-items:flex-end;justify-content:center;animation:fadeIn 0.15s ease;}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{background:var(--white);border-radius:20px 20px 0 0;padding:26px 22px 32px;width:100%;max-width:480px;animation:slideUp 0.2s ease;}
@keyframes slideUp{from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
.modal-title{font-family:'Cormorant Garamond',serif;font-size:22px;color:var(--dark);margin-bottom:8px;}
.modal-sub{font-size:13.5px;color:var(--muted);margin-bottom:20px;line-height:1.65;}
.modal-btns{display:flex;gap:9px;}
.modal-cancel{flex:1;padding:13px;border-radius:12px;background:var(--cream);border:1.5px solid var(--border);color:var(--warm);font-size:14px;font-weight:500;cursor:pointer;}
.modal-confirm{flex:1;padding:13px;border-radius:12px;background:var(--dark);border:none;color:var(--white);font-size:14px;font-weight:500;cursor:pointer;transition:background 0.15s;}
.modal-confirm:hover{background:#8B2F0A;}

/* ── Lang switch modal ── */
.lang-switch-modal{background:var(--white);border-radius:20px 20px 0 0;padding:26px 22px 32px;width:100%;max-width:480px;animation:slideUp 0.2s ease;}
.lang-switch-modal .modal-title{margin-bottom:20px;}
`;

// ─────────────────────────────────────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────────────────────────────────────
const SB_URL = "https://wzwwtghtnkapdwlgnrxr.supabase.co";
const SB_KEY = "sb_publishable_w5_9MXaM2XAZRk2b8rquoQ_kFpcUMTA";

const sbGet = async (hhId) => {
  const res = await fetch(`${SB_URL}/rest/v1/households?id=eq.${hhId}&select=data`, {
    headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` }
  });
  const rows = await res.json();
  return rows?.[0]?.data || null;
};

const sbSet = async (hhId, data) => {
  await fetch(`${SB_URL}/rest/v1/households`, {
    method: "POST",
    headers: {
      "apikey": SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ id: hhId, data, updated_at: new Date().toISOString() })
  });
};

// Messages stay in localStorage — private per device
const lsGet = (key) => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const lsSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

const uid8 = () => Math.random().toString(36).slice(2, 10);
const uid  = () => Math.random().toString(36).slice(2, 6);

function CheckSVG() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
const buildPrompt = (household, tasks, shopping, user, lang) => {
  const isHe = lang === "he";
  const langNote = isHe
    ? `The household language is Hebrew. ALWAYS respond in Hebrew.

Tone in Hebrew:
- Friendly and warm, like a good friend who also keeps things organised.
- Write in clear, natural Hebrew — not formal, not bureaucratic, but also not slang-heavy.
- Occasional light slang is fine when it fits naturally (e.g. "סבבה", "אחלה") — but it should never be the default register.
- Use gender-neutral plural forms (רבים) throughout: "תוסיפו", "תגידו", "בדקו" — not singular gendered forms.
- Never use "עליו" or "עליה" to refer to the person speaking. If you need to refer back, use their name or rephrase.
- Short sentences. Get to the point. No unnecessary padding.`
    : "The household language is English.";

  return `You are Ours — the shared AI for the ${household.name}.
${langNote}

Members: ${household.members.map(m => m.name).join(", ")}.
Talking to: ${user.name}.

Personality: warm, direct. No filler phrases. Short responses unless detail is needed. Never nag. Use names naturally.

CURRENT TASKS:
${tasks.length === 0 ? "(none)" : tasks.map(t => `• [${t.done?"done":"open"}] ${t.title}${t.assignedTo?` → ${t.assignedTo}`:""} (id:${t.id})`).join("\n")}

CURRENT SHOPPING LIST:
${shopping.length === 0 ? "(empty)" : shopping.map(s => `• [${s.got?"got":"need"}] ${s.name}${s.qty?` ×${s.qty}`:""} [${s.category}] (id:${s.id})`).join("\n")}

Respond ONLY as this exact JSON — no other text, no markdown fences:
{"message":"...","tasks":[],"shopping":[]}

Task shape: {"id":"xxxx","title":"...","assignedTo":"name or null","done":false,"completedBy":"name or null","completedAt":"ISO string or null"}
Shopping shape: {"id":"xxxx","name":"...","qty":"number string or null","category":"one of the category names","got":false}

${isHe
  ? 'Shopping categories (use these exact Hebrew names): פירות וירקות, חלב וביצים, בשר ודגים, מאפים, מזווה, מוצרים קפואים, משקאות, ניקוי ובית, מוצרים מחנות הטבע, אחר'
  : 'Shopping categories: Produce, Dairy, Meat, Bakery, Pantry, Frozen, Drinks, Household, Health Store, Other'
}

Always return full arrays. Generate 4-char alphanumeric IDs for new items.`.trim();
};

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────
function Setup({ onDone }) {
  const [step, setStep]       = useState(0); // 0=lang, 1=details
  const [lang, setLang]       = useState(null);
  const [hhName, setHhName]   = useState("");
  const [members, setMembers] = useState([]);
  const [newM, setNewM]       = useState("");

  const t = lang ? T[lang] : T.en;
  const dir = lang === "he" ? "rtl" : "ltr";

  const addMember = () => {
    const n = newM.trim();
    if (!n || members.find(m => m.name.toLowerCase() === n.toLowerCase())) return;
    setMembers(p => [...p, { id: uid(), name: n }]);
    setNewM("");
  };

  const selectLang = (l) => { setLang(l); setTimeout(() => setStep(1), 160); };

  return (
    <div className="setup-wrap" dir={dir} style={{ fontFamily: lang === "he" ? "'Heebo',sans-serif" : "'DM Sans',sans-serif" }}>
      <div className="setup-mark">Ours</div>
      <p className="setup-tagline">AI for the life you share together</p>

      <div className="setup-form">
        {step === 0 && (
          <>
            <p className="step-label">{lang === "he" ? T.he.langStep : T.en.langStep}</p>
            <div className="lang-cards">
              {[{code:"en",label:"EN",sub:"English"},{code:"he",label:"HE",sub:"עברית"}].map(l => (
                <div key={l.code} className={`lang-card ${lang===l.code?"selected":""}`} onClick={() => selectLang(l.code)}>
                  <span className="lang-flag">{l.label}</span>
                  <span className="lang-name">{l.sub}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="field">
              <label className="field-label">{t.hhLabel}</label>
              <input className="field-input" placeholder={t.hhPlaceholder} value={hhName}
                onChange={e => setHhName(e.target.value)} dir={dir} />
            </div>
            <div className="field">
              <label className="field-label">{t.whoLabel}</label>
              {t.whoSub && <p className="field-sub">{t.whoSub}</p>}
              {members.length > 0 && (
                <div className="tags">
                  {members.map(m => (
                    <div className="tag" key={m.id}>{m.name}
                      <button className="tag-x" onClick={() => setMembers(p => p.filter(x => x.id !== m.id))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="add-row">
                <input className="add-input" placeholder={t.addPlaceholder} value={newM} dir={dir}
                  onChange={e => setNewM(e.target.value)} onKeyDown={e => e.key === "Enter" && addMember()} />
                <button className="add-mini" onClick={addMember}>{t.addBtn}</button>
              </div>
            </div>
            <button className="go-btn" disabled={!hhName.trim() || members.length < 1}
              onClick={() => onDone({ name: hhName.trim(), members, lang })}>
              {t.goBtn}
            </button>
            <button className="back-btn" onClick={() => setStep(0)}>
              {lang === "he" ? "שינוי שפה ←" : "← Change language"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const formatTs = (iso, lang) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  const day  = `${pad(d.getDate())}.${pad(d.getMonth()+1)}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${day} ${time}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// TASKS VIEW
// ─────────────────────────────────────────────────────────────────────────────
function TasksView({ tasks, user, lang, onToggle, onClaim, onDelete, onClearDone, t }) {
  const open = tasks.filter(x => !x.done);
  const done = tasks.filter(x => x.done);
  return (
    <div className="list-view">
      <div className="list-header">
        <div className="list-title">{t.tasksTitle}</div>
        {done.length > 0 && <button className="clear-btn" onClick={onClearDone}>{t.clearDone}</button>}
      </div>
      {tasks.length === 0 ? (
        <div className="list-empty">
          <div className="list-empty-icon">📋</div>
          <p className="list-empty-text">{t.tasksEmpty}</p>
        </div>
      ) : (
        <>
          {open.length === 0 && done.length > 0 && (
            <div className="all-done-msg">{t.allDone}</div>
          )}
          {open.length > 0 && (
            <>
              <div className="section-head">{t.sectionTodo(open.length)}</div>
              {open.map(task => (
                <div key={task.id} className="task-row">
                  <div className={`check-circle ${task.done?"on":""}`} onClick={() => onToggle(task.id)}>
                    <CheckSVG />
                  </div>
                  <div className="task-text">{task.title}</div>
                  {task.assignedTo
                    ? <div className="assignee-badge">
                        {task.assignedTo}
                        <button className="badge-x" onClick={() => onClaim(task.id, null)}>×</button>
                      </div>
                    : <button className="take-btn" onClick={() => onClaim(task.id, user.name)}>{t.takeIt}</button>
                  }
                  <button className="del-btn" onClick={() => onDelete("task", task.id)}>×</button>
                </div>
              ))}
            </>
          )}
          {done.length > 0 && (
            <>
              <div className="section-head">{t.sectionDone(done.length)}</div>
              {done.map(task => {
                const who = task.completedBy || task.assignedTo || null;
                const ts  = formatTs(task.completedAt, lang);
                return (
                  <div key={task.id} className="task-row done">
                    <div className="check-circle on" onClick={() => onToggle(task.id)}>
                      <CheckSVG />
                    </div>
                    <div className="task-col">
                      <div className="task-text">{task.title}</div>
                      {who && <div className="task-meta">{ts ? t.completedAt(who, ts) : t.doneBy(who)}</div>}
                    </div>
                    <button className="del-btn" onClick={() => onDelete("task", task.id)}>×</button>
                  </div>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOPPING VIEW
// ─────────────────────────────────────────────────────────────────────────────
function ShoppingView({ shopping, onToggle, onDelete, onClearGot, t }) {
  const need = shopping.filter(s => !s.got);
  const got  = shopping.filter(s => s.got);
  const grouped = {};
  need.forEach(s => { const c = s.category || t.cats[8]; if (!grouped[c]) grouped[c] = []; grouped[c].push(s); });
  const usedCats = t.cats.filter(c => grouped[c]?.length > 0);

  return (
    <div className="list-view">
      <div className="list-header">
        <div className="list-title">{t.shopTitle}</div>
        {got.length > 0 && <button className="clear-btn" onClick={onClearGot}>{t.clearCart}</button>}
      </div>
      {shopping.length === 0 ? (
        <div className="list-empty">
          <div className="list-empty-icon">🛒</div>
          <p className="list-empty-text">{t.shopEmpty}</p>
        </div>
      ) : (
        <>
          {need.length === 0 && (
            <div className="all-done-msg">{t.allInCart}</div>
          )}
          {usedCats.map(cat => (
            <div key={cat}>
              <div className="section-head">{cat}</div>
              {grouped[cat].map(s => (
                <div key={s.id} className="shop-row">
                  <div className={`shop-check ${s.got?"on":""}`} onClick={() => onToggle(s.id)}>
                    <CheckSVG />
                  </div>
                  <div className="shop-text">
                    <div className="shop-name">{s.name}</div>
                    {s.qty && <div className="shop-qty">{t.qtyLabel(s.qty)}</div>}
                  </div>
                  <button className="del-btn" onClick={() => onDelete("shop", s.id)}>×</button>
                </div>
              ))}
            </div>
          ))}
          {got.length > 0 && (
            <>
              <div className="section-head">{t.inCart(got.length)}</div>
              {got.map(s => (
                <div key={s.id} className="shop-row got">
                  <div className="shop-check on" onClick={() => onToggle(s.id)}>
                    <CheckSVG />
                  </div>
                  <div className="shop-text"><div className="shop-name">{s.name}</div></div>
                  <div className="cat-badge">{s.category}</div>
                  <button className="del-btn" onClick={() => onDelete("shop", s.id)}>×</button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LANG SWITCH MODAL
// ─────────────────────────────────────────────────────────────────────────────
function LangModal({ lang, onSelect, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="lang-switch-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title" style={{fontFamily:"'Cormorant Garamond',serif"}}>
          {lang === "he" ? T.he.langStep : T.en.langStep}
        </div>
        <div className="lang-cards">
          {[{code:"en",label:"EN",sub:"English"},{code:"he",label:"HE",sub:"עברית"}].map(l => (
            <div key={l.code} className={`lang-card ${lang===l.code?"selected":""}`} onClick={() => onSelect(l.code)}>
              <span className="lang-flag">{l.label}</span>
              <span className="lang-name">{l.sub}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function Ours() {
  const [screen, setScreen]       = useState("loading");
  const [tab, setTab]             = useState("chat");
  const [household, setHousehold] = useState(null);
  const [user, setUser]           = useState(null);
  const [lang, setLang]           = useState("en");
  const [allMsgs, setAllMsgs]     = useState({});
  const [tasks, setTasks]         = useState([]);
  const [shopping, setShopping]   = useState([]);
  const [input, setInput]         = useState("");
  const [busy, setBusy]           = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [showLang, setShowLang]   = useState(false);
  const [copied, setCopied]       = useState(false);
  const [theme, setTheme]         = useState(() => lsGet("ours-theme") || "auto");
  const [editName, setEditName]   = useState("");
  const isFounder = !!lsGet("ours-founder");
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const t   = T[lang] || T.en;
  const dir = t.dir;
  const msgs = user ? (allMsgs[user.id] || []) : [];
  const sendArrow = dir === "rtl" ? "←" : "→";

  // ── Boot ──
  useEffect(() => {
    (async () => {
      // ?join=hhId from share link
      const params = new URLSearchParams(window.location.search);
      const joinId = params.get("join");
      if (joinId) {
        try {
          const data = await sbGet(joinId);
          if (data) {
            setHousehold(data.hh); setLang(data.hh.lang || "en");
            setTasks(data.tasks || []); setShopping(data.shopping || []);
            window.history.replaceState({}, "", window.location.pathname);
            setScreen("pick"); return;
          }
        } catch {}
      }
      // existing household in localStorage
      const hhId = lsGet("ours-hhid");
      if (hhId) {
        try {
          const data = await sbGet(hhId);
          if (data) {
            setHousehold(data.hh); setLang(data.hh.lang || "en");
            setTasks(data.tasks || []); setShopping(data.shopping || []);
            const msgs = lsGet("ours-msgs") || {};
            setAllMsgs(msgs);
            // If user already chose their name on this device — go straight to chat
            const savedUser = lsGet("ours-user");
            if (savedUser) {
              // Verify the saved user still exists in the household
              const stillExists = data.hh.members.find(m => m.id === savedUser.id);
              if (stillExists) {
                setUser(stillExists);
                setScreen("chat"); return;
              }
            }
            setScreen("pick"); return;
          }
        } catch {}
      }
      setScreen("setup");
    })();
  }, []);

  // ── Theme ──
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    lsSet("ours-theme", theme);
  }, [theme]);

  // ── Scroll ──
  useEffect(() => {
    if (tab === "chat") bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy, tab]);

  // ── Persist ──
  const save = async (hh, m, tk, sh) => {
    const hhId = lsGet("ours-hhid");
    if (!hhId) return;
    const current = {
      hh:       hh       !== undefined ? hh       : household,
      tasks:    tk       !== undefined ? tk       : tasks,
      shopping: sh       !== undefined ? sh       : shopping,
    };
    await sbSet(hhId, current);
    if (m !== undefined) lsSet("ours-msgs", m);
  };

  // ── Setup done ──
  const handleSetup = async (hh) => {
    const hhId = uid8();
    hh.id = hhId;
    lsSet("ours-hhid", hhId);
    lsSet("ours-founder", true); // this device created the household
    await sbSet(hhId, { hh, tasks: [], shopping: [] });
    setHousehold(hh); setLang(hh.lang || "en");
    setTasks([]); setShopping([]);
    setScreen("pick");
  };

  // ── Reset ──
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
    setHousehold(null); setUser(null); setAllMsgs({}); setTasks([]); setShopping([]); setInput("");
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
    setHousehold(updatedHh);
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
      setHousehold(updated);
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
    setTasks(n); await save(undefined, undefined, n, undefined);
  };
  const claimTask = async (id, name) => {
    const n = tasks.map(x => x.id === id ? { ...x, assignedTo: name } : x);
    setTasks(n); await save(undefined, undefined, n, undefined);
  };
  const toggleShop = async (id) => { const n = shopping.map(x => x.id===id ? {...x,got:!x.got} : x); setShopping(n); await save(undefined,undefined,undefined,n); };
  const deleteItem = async (type, id) => {
    if (type === "task") { const n = tasks.filter(x => x.id!==id); setTasks(n); await save(undefined,undefined,n,undefined); }
    else { const n = shopping.filter(x => x.id!==id); setShopping(n); await save(undefined,undefined,undefined,n); }
  };
  const clearDone = async () => { const n = tasks.filter(x => !x.done); setTasks(n); await save(undefined,undefined,n,undefined); };
  const clearGot  = async () => { const n = shopping.filter(x => !x.got); setShopping(n); await save(undefined,undefined,undefined,n); };

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
        headers: {
            "Content-Type": "application/json",
          },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1200,
          system: buildPrompt(household, tasks, shopping, user, lang),
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
      setAllMsgs(finalAll); setTasks(newTasks); setShopping(newShop);
      await save(undefined, finalAll, newTasks, newShop);
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
    <>
      <style>{CSS}</style>
      <div style={{height:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F5F0E8",fontSize:14,color:"#8A8070"}}>
        {T.en.loading}
      </div>
    </>
  );

  if (screen === "setup") return <><style>{CSS}</style><Setup onDone={handleSetup} /></>;

  // ── User picker screen ──
  if (screen === "pick") {
    const pickDir = (household?.lang || "en") === "he" ? "rtl" : "ltr";
    const pickFont = pickDir === "rtl" ? "'Heebo',sans-serif" : "'DM Sans',sans-serif";
    return (
      <>
        <style>{CSS}</style>
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
                  // Save hhId locally if joining for the first time
                  if (!lsGet("ours-hhid") && household?.id) {
                    lsSet("ours-hhid", household.id);
                  }
                  // Fetch latest shared data from Supabase
                  const hhId = lsGet("ours-hhid") || household?.id;
                  if (hhId) {
                    try {
                      const data = await sbGet(hhId);
                      if (data) {
                        setTasks(data.tasks || []);
                        setShopping(data.shopping || []);
                      }
                    } catch {}
                  }
                  const msgs = lsGet("ours-msgs") || {};
                  setAllMsgs(msgs);
                  // Lock this user to this device
                  lsSet("ours-user", m);
                  setUser(m);
                  setScreen("chat");
                }}>
                {m.name}
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>

      {/* Settings modal */}
      {showReset && (
        <div className="overlay" onClick={() => setShowReset(false)}>
          <div className="modal" dir={dir} onClick={e => e.stopPropagation()} style={{display:"flex",flexDirection:"column",gap:22}}>
            <div className="modal-title">{t.settingsTitle}</div>

            {/* Rename */}
            <div>
              <div style={{fontSize:11,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>{t.settingsName}</div>
              <div style={{display:"flex",gap:8}}>
                <input
                  style={{flex:1,padding:"10px 13px",borderRadius:10,border:"1.5px solid var(--border)",background:"var(--cream)",fontFamily:"inherit",fontSize:14,color:"var(--dark)",outline:"none"}}
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
              <div style={{fontSize:11,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>{t.settingsTheme}</div>
              <div style={{display:"flex",gap:7}}>
                {[["light", t.themeLight], ["dark", t.themeDark], ["auto", t.themeAuto]].map(([val, label]) => (
                  <button key={val} onClick={() => setTheme(val)}
                    style={{flex:1,padding:"9px 6px",borderRadius:10,border:`1.5px solid ${theme===val?"var(--dark)":"var(--border)"}`,background:theme===val?"var(--dark)":"transparent",color:theme===val?"var(--white)":"var(--warm)",fontSize:12.5,fontWeight:500,cursor:"pointer",fontFamily:"inherit",transition:"all 0.15s"}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Reset — founder only */}
            {isFounder && (
              <div>
                <div style={{fontSize:11,fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>{t.settingsDanger}</div>
                <div className="modal-btns">
                  <button className="modal-cancel" onClick={() => setShowReset(false)}>{t.resetCancel}</button>
                  <button className="modal-confirm" onClick={doReset}>{t.resetConfirm}</button>
                </div>
              </div>
            )}

            {!isFounder && (
              <button className="modal-cancel" onClick={() => setShowReset(false)} style={{marginTop:-8}}>{t.resetCancel}</button>
            )}
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
          <div className="modal" dir={dir} onClick={e => e.stopPropagation()}>
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
            <div style={{fontSize:13,fontWeight:500,color:"var(--warm)",paddingRight:4}}>{user.name}</div>
            <button className={`icon-btn`} onClick={() => setShowReset(true)} title={t.settingsTitle}>⚙</button>
            <button className={`icon-btn`} onClick={shareLink}
              title={dir==="rtl" ? "שתפו קישור הצטרפות" : "Share join link"}
              style={copied ? {color:"var(--green)",opacity:1} : {}}>
              {copied ? "✓" : "🔗"}
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
                  {listening ? "⏹" : "🎤"}
                </button>
                <button className="send-btn" onClick={() => send()} disabled={!input.trim() || busy}>
                  {sendArrow}
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

        </div>

        {/* ── Bottom Nav ── */}
        <div className="bottom-nav">
          <button className={`nav-btn ${tab==="chat"?"active":""}`} onClick={() => setTab("chat")}>
            <span className="nav-icon">💬</span>
            <span className="nav-label">{t.navChat}</span>
          </button>
          <button className={`nav-btn ${tab==="tasks"?"active":""}`} onClick={() => setTab("tasks")}>
            <span className="nav-icon">✅</span>
            <span className="nav-label">{t.navTasks}</span>
            {openTasks > 0 && <span className="nav-badge">{openTasks}</span>}
          </button>
          <button className={`nav-btn ${tab==="shopping"?"active":""}`} onClick={() => setTab("shopping")}>
            <span className="nav-icon">🛒</span>
            <span className="nav-label">{t.navShopping}</span>
            {neededItems > 0 && <span className="nav-badge">{neededItems}</span>}
          </button>
        </div>

      </div>
    </>
  );
}
