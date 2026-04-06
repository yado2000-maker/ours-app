import CheckSVG from "./CheckSVG.jsx";
import { EmptyTasksIcon, DeleteIcon } from "./Icons.jsx";

const formatTs = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  const day  = `${pad(d.getDate())}.${pad(d.getMonth()+1)}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${day} ${time}`;
};

export default function TasksView({ tasks, user, lang, onToggle, onClaim, onDelete, onClearDone, t, pendingDelete, loading }) {
  const open = tasks.filter(x => !x.done);
  const done = tasks.filter(x => x.done);
  return (
    <div className="list-view">
      <div className="list-header">
        <div className="list-title">{t.tasksTitle}</div>
        {done.length > 0 && <button className="clear-btn" onClick={onClearDone}>{t.clearDone}</button>}
      </div>
      {loading ? (
        <div className="list-empty"><div style={{fontSize:13,color:"var(--muted)",padding:24,textAlign:"center"}}>{(t.loading || "Loading...")}</div></div>
      ) : tasks.length === 0 ? (
        <div className="list-empty">
          <div className="list-empty-icon"><EmptyTasksIcon size={44} /></div>
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
                  <button className={`del-btn ${pendingDelete?.type === "task" && pendingDelete?.id === task.id ? "confirming" : ""}`}
                      onClick={() => onDelete("task", task.id)}>{pendingDelete?.type === "task" && pendingDelete?.id === task.id ? "?" : <DeleteIcon size={14} />}</button>
                </div>
              ))}
            </>
          )}
          {done.length > 0 && (
            <>
              <div className="section-head">{t.sectionDone(done.length)}</div>
              {done.map(task => {
                const who = task.completedBy || task.assignedTo || null;
                const ts  = formatTs(task.completedAt);
                return (
                  <div key={task.id} className="task-row done">
                    <div className="check-circle on" onClick={() => onToggle(task.id)}>
                      <CheckSVG />
                    </div>
                    <div className="task-col">
                      <div className="task-text">{task.title}</div>
                      {who && <div className="task-meta">{ts ? t.completedAt(who, ts) : t.doneBy(who)}</div>}
                    </div>
                    <button className={`del-btn ${pendingDelete?.type === "task" && pendingDelete?.id === task.id ? "confirming" : ""}`}
                      onClick={() => onDelete("task", task.id)}>{pendingDelete?.type === "task" && pendingDelete?.id === task.id ? "?" : <DeleteIcon size={14} />}</button>
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
