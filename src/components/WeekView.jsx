import { useState } from "react";
import { EmptyCalendarIcon, ChevronLeftIcon, ChevronRightIcon, DeleteIcon, CalendarSyncIcon } from "./Icons.jsx";
import { syncEventToGoogleCalendar } from "../lib/google-calendar.js";

export default function WeekView({ tasks, events, rotations, t, lang, onDeleteEvent, googleAccessToken }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [syncingId, setSyncingId] = useState(null);
  const [syncedIds, setSyncedIds] = useState({});

  async function handleSync(item) {
    if (!googleAccessToken) {
      alert(t.gcalNotConnected);
      return;
    }
    setSyncingId(item.id);
    try {
      const res = await syncEventToGoogleCalendar({
        accessToken: googleAccessToken,
        event: { title: item.title, scheduledFor: item.scheduledFor, durationMinutes: 60 },
      });
      setSyncedIds(prev => ({ ...prev, [item.id]: res.htmlLink }));
    } catch (e) {
      alert(`${t.gcalSyncFailed}: ${e.message}`);
    } finally {
      setSyncingId(null);
    }
  }
  const today = new Date();

  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + weekOffset * 7);
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    return d;
  });

  const doneTasks = tasks.filter(task => {
    if (!task.done || !task.completedAt) return false;
    const ts = new Date(task.completedAt);
    return ts >= startOfWeek && ts <= endOfWeek;
  });

  const weekEvents = (events || []).filter(ev => {
    if (!ev.scheduledFor) return false;
    const ts = new Date(ev.scheduledFor);
    return ts >= startOfWeek && ts <= endOfWeek;
  });

  const byDay = {};
  doneTasks.forEach(task => {
    const d = new Date(task.completedAt).getDay();
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push({ ...task, _type: "done" });
  });
  weekEvents.forEach(ev => {
    const d = new Date(ev.scheduledFor).getDay();
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push({ ...ev, _type: "event" });
  });
  // Compute rotation entries for the week
  (rotations || []).forEach(rot => {
    const members = Array.isArray(rot.members) ? rot.members :
      (typeof rot.members === "string" ? JSON.parse(rot.members) : []);
    if (!members.length) return;
    const baseIndex = rot.current_index || 0;
    const todayIdx = days.findIndex(d => d.toDateString() === new Date().toDateString());

    days.forEach((day, dayIdx) => {
      if (rot.type === "order") {
        // Order rotations: show every day (who goes first)
        const offset = dayIdx - (todayIdx >= 0 ? todayIdx : 0);
        const memberIdx = ((baseIndex + offset) % members.length + members.length) % members.length;
        const d = day.getDay();
        if (!byDay[d]) byDay[d] = [];
        byDay[d].push({
          id: `rot-${rot.id}-${dayIdx}`,
          title: rot.title,
          assignedTo: members[memberIdx],
          scheduledFor: day.toISOString(),
          _type: "rotation",
          _rotationType: rot.type,
        });
      }

      if (rot.type === "duty" && rot.frequency) {
        // Duty rotations with frequency: show on matching days
        let showDay = false;
        if (rot.frequency.type === "daily") showDay = true;
        if (rot.frequency.type === "weekly") {
          const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
          showDay = (rot.frequency.days || []).includes(dayNames[day.getDay()]);
        }

        if (showDay) {
          const offset = dayIdx - (todayIdx >= 0 ? todayIdx : 0);
          const memberIdx = ((baseIndex + offset) % members.length + members.length) % members.length;
          const d = day.getDay();
          if (!byDay[d]) byDay[d] = [];
          byDay[d].push({
            id: `rot-${rot.id}-${dayIdx}`,
            title: rot.title,
            assignedTo: members[memberIdx],
            scheduledFor: day.toISOString(),
            _type: "rotation",
            _rotationType: rot.type,
          });
        }
      }
    });
  });

  Object.values(byDay).forEach(arr => arr.sort((a, b) => {
    const aTime = a._type === "done" ? a.completedAt : a.scheduledFor;
    const bTime = b._type === "done" ? b.completedAt : b.scheduledFor;
    return new Date(aTime) - new Date(bTime);
  }));

  const rotationCount = Object.values(byDay).reduce((sum, arr) => sum + arr.filter(x => x._type === "rotation").length, 0);
  const allWeekItems = [...doneTasks, ...weekEvents];
  const hasContent = allWeekItems.length > 0 || rotationCount > 0;
  const pad = n => String(n).padStart(2, "0");
  const fmtTime = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const isToday = d => weekOffset === 0 && d.toDateString() === today.toDateString();
  const weekRange = `${pad(days[0].getDate())}.${pad(days[0].getMonth()+1)} \u2013 ${pad(days[6].getDate())}.${pad(days[6].getMonth()+1)}`;
  const weekLabel = () => {
    if (weekOffset === 0)  return t.weekTitle;
    if (weekOffset === -1) return lang === "he" ? "\u05D4\u05E9\u05D1\u05D5\u05E2 \u05E9\u05E2\u05D1\u05E8" : "Last week";
    if (weekOffset === 1)  return lang === "he" ? "\u05D4\u05E9\u05D1\u05D5\u05E2 \u05D4\u05D1\u05D0"  : "Next week";
    return weekRange;
  };

  return (
    <div className="week-view">
      <div className="week-header">
        <div className="week-title">{weekLabel()}</div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          {weekOffset !== 0 && (
            <button onClick={() => setWeekOffset(0)}
              style={{fontSize:11,color:"var(--accent)",background:"none",border:"1.5px solid var(--accent-mid)",borderRadius:100,padding:"2px 10px",cursor:"pointer",fontFamily:"inherit",fontWeight:500}}>
              {lang === "he" ? "\u05D4\u05E9\u05D1\u05D5\u05E2" : "This week"}
            </button>
          )}
          <button className="week-nav-btn" onClick={() => setWeekOffset(w => w - 1)} aria-label={lang === "he" ? "השבוע הקודם" : "Previous week"}>
            {lang === "he" ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
          </button>
          <div style={{fontSize:11.5,color:"var(--muted)",minWidth:70,textAlign:"center"}}>{weekRange}</div>
          <button className="week-nav-btn" onClick={() => setWeekOffset(w => w + 1)} aria-label={lang === "he" ? "השבוע הבא" : "Next week"}>
            {lang === "he" ? <ChevronLeftIcon size={16} /> : <ChevronRightIcon size={16} />}
          </button>
        </div>
      </div>
      {!hasContent ? (
        <div className="week-empty">
          <div className="week-empty-icon"><EmptyCalendarIcon size={44} /></div>
          <p className="week-empty-text">{t.weekEmpty}</p>
        </div>
      ) : (
        <div className="week-agenda">
          {days.map((day, i) => {
            const dayItems = byDay[i] || [];
            const todayFlag = isToday(day);
            return (
              <div key={i} className={`week-day-row ${todayFlag ? "today" : ""} ${dayItems.length === 0 ? "empty" : ""}`}>
                <div className="week-day-head">
                  <div className={`week-day-name ${todayFlag ? "today" : ""}`}>{t.weekDays[i]}</div>
                  <div className={`week-day-num ${todayFlag ? "today" : ""}`}>{day.getDate()}</div>
                  {todayFlag && <div className="week-day-badge">{lang === "he" ? "היום" : "Today"}</div>}
                </div>
                <div className="week-day-items">
                  {dayItems.length === 0 ? (
                    <div className="week-day-empty" aria-hidden="true">—</div>
                  ) : dayItems.map(item => (
                    <div key={item.id} className={`week-task-chip ${item._type === "rotation" ? "scheduled" : item._type === "event" ? "scheduled" : ""}`}>
                      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:6}}>
                        <div className="week-task-name">{item.title}</div>
                        {item._type === "event" && (
                          <div style={{display:"flex",alignItems:"flex-start",gap:6,flexShrink:0}}>
                            <button onClick={() => handleSync(item)}
                              disabled={syncingId === item.id || !!syncedIds[item.id]}
                              title={syncedIds[item.id] ? t.gcalSynced : t.syncToGcal}
                              aria-label={syncedIds[item.id] ? t.gcalSynced : t.syncToGcal}
                              className={`week-task-sync-btn ${syncedIds[item.id] ? "synced" : ""} ${syncingId === item.id ? "syncing" : ""}`}>
                              {syncingId === item.id ? (
                                <span className="week-sync-spinner" aria-hidden="true" />
                              ) : (
                                <CalendarSyncIcon size={14} synced={!!syncedIds[item.id]} />
                              )}
                            </button>
                            <button onClick={() => onDeleteEvent(item.id)}
                              style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:12,lineHeight:1,padding:0,opacity:0.6,marginTop:1}}
                              onMouseOver={e=>e.currentTarget.style.opacity=1}
                              onMouseOut={e=>e.currentTarget.style.opacity=0.6}>
                              <DeleteIcon size={12} />
                            </button>
                          </div>
                        )}
                      </div>
                      {item._type === "rotation" ? (
                        <div className="week-task-meta">
                          {item.assignedTo && <span className="week-task-who">{item.assignedTo}</span>}
                          <span className="week-task-time" style={{color: "var(--accent)", opacity: 0.8}}>
                            {item._rotationType === "order" ? "סדר" : "תורנות"}
                          </span>
                        </div>
                      ) : item._type === "event" ? (
                        <div className="week-task-meta">
                          {item.assignedTo && <span className="week-task-who">{item.assignedTo}</span>}
                          <span className="week-task-time" style={{color:"var(--accent)"}}>
                            {fmtTime(item.scheduledFor)}
                          </span>
                        </div>
                      ) : (
                        <div className="week-task-meta">
                          {item.completedBy && <span className="week-task-who">{item.completedBy}</span>}
                          <span className="week-task-time">{fmtTime(item.completedAt)}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
