import { useState } from "react";
import { EmptyCalendarIcon, ChevronLeftIcon, ChevronRightIcon, DeleteIcon } from "./Icons.jsx";

export default function WeekView({ tasks, events, t, lang, onDeleteEvent }) {
  const [weekOffset, setWeekOffset] = useState(0);
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
  Object.values(byDay).forEach(arr => arr.sort((a, b) => {
    const aTime = a._type === "done" ? a.completedAt : a.scheduledFor;
    const bTime = b._type === "done" ? b.completedAt : b.scheduledFor;
    return new Date(aTime) - new Date(bTime);
  }));

  const allWeekItems = [...doneTasks, ...weekEvents];
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
          <button className="week-nav-btn" onClick={() => setWeekOffset(w => w - 1)}>
            <ChevronLeftIcon size={16} />
          </button>
          <div style={{fontSize:11.5,color:"var(--muted)",minWidth:70,textAlign:"center"}}>{weekRange}</div>
          <button className="week-nav-btn" onClick={() => setWeekOffset(w => w + 1)}>
            <ChevronRightIcon size={16} />
          </button>
        </div>
      </div>
      {allWeekItems.length === 0 ? (
        <div className="week-empty">
          <div className="week-empty-icon"><EmptyCalendarIcon size={44} /></div>
          <p className="week-empty-text">{t.weekEmpty}</p>
        </div>
      ) : (
        <div className="week-grid">
          {days.map((day, i) => (
            <div key={i} className="week-col">
              <div className={`week-day-label ${isToday(day) ? "today" : ""}`}>{t.weekDays[i]}</div>
              <div className={`week-date ${isToday(day) ? "today" : ""}`}>{day.getDate()}</div>
              {(byDay[i] || []).map(item => (
                <div key={item.id} className={`week-task-chip ${item._type === "event" ? "scheduled" : ""}`}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:3}}>
                    <div className="week-task-name">{item.title}</div>
                    {item._type === "event" && (
                      <button onClick={() => onDeleteEvent(item.id)}
                        style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:12,lineHeight:1,padding:0,flexShrink:0,opacity:0.6,marginTop:1}}
                        onMouseOver={e=>e.currentTarget.style.opacity=1}
                        onMouseOut={e=>e.currentTarget.style.opacity=0.6}>
                        <DeleteIcon size={12} />
                      </button>
                    )}
                  </div>
                  {item._type === "event" ? (
                    <>
                      {item.assignedTo && <div className="week-task-who">{item.assignedTo}</div>}
                      <div className="week-task-time" style={{color:"var(--accent)"}}>
                        {fmtTime(item.scheduledFor)}
                      </div>
                    </>
                  ) : (
                    <>
                      {item.completedBy && <div className="week-task-who">{item.completedBy}</div>}
                      <div className="week-task-time">{fmtTime(item.completedAt)}</div>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
