import { useEffect, useRef, useState } from "react";
import CheckSVG from "./CheckSVG.jsx";
import { EmptyTasksIcon, DeleteIcon } from "./Icons.jsx";
import TagFilter, { useTagFilter, filterByTag, tagsFromItems } from "./TagFilter.jsx";
import TagChipsEditor from "./TagChipsEditor.jsx";
import NewItemInput from "./NewItemInput.jsx";

const formatTs = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, "0");
  const day  = `${pad(d.getDate())}.${pad(d.getMonth()+1)}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${day} ${time}`;
};

// Inline-edit row. Renders title + tag editor as form fields; saves on blur or
// Enter, cancels on Escape. The save handler is fire-and-forget — App.jsx
// already pipes the changes through saveTask + lastSaveRef debounce.
function TaskEditRow({ task, suggestions, onSave, onCancel }) {
  const [title, setTitle] = useState(task.title || "");
  const [tags, setTags] = useState(Array.isArray(task.tags) ? task.tags : []);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const next = title.trim();
    if (!next) {
      onCancel();
      return;
    }
    const titleChanged = next !== (task.title || "");
    const tagsChanged = JSON.stringify(tags) !== JSON.stringify(task.tags || []);
    if (titleChanged || tagsChanged) {
      onSave({ title: next, tags });
    } else {
      onCancel();
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="task-row task-row-editing">
      <input
        ref={inputRef}
        type="text"
        className="task-edit-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
      <TagChipsEditor value={tags} onChange={setTags} suggestions={suggestions} compact />
    </div>
  );
}

export default function TasksView({ tasks, user, lang, onToggle, onClaim, onDelete, onClearDone, onAdd, onUpdate, t, pendingDelete, loading }) {
  const [activeTag, setActiveTag] = useTagFilter();
  const [editingId, setEditingId] = useState(null);

  const visible = filterByTag(tasks, activeTag);
  const open = visible.filter(x => !x.done);
  const done = visible.filter(x => x.done);

  const tagSuggestions = tagsFromItems(tasks).map(({ tag }) => tag);

  const renderOpenRow = (task) => {
    if (editingId === task.id) {
      return (
        <TaskEditRow
          key={task.id}
          task={task}
          suggestions={tagSuggestions}
          onSave={(patch) => { onUpdate?.(task.id, patch); setEditingId(null); }}
          onCancel={() => setEditingId(null)}
        />
      );
    }
    const taskTags = Array.isArray(task.tags) ? task.tags : [];
    return (
      <div key={task.id} className="task-row">
        <div className={`check-circle ${task.done?"on":""}`} onClick={() => onToggle(task.id)}>
          <CheckSVG />
        </div>
        <div className="task-col">
          <div
            className="task-text task-text-editable"
            onClick={() => onUpdate && setEditingId(task.id)}
            title={onUpdate ? "tap to edit" : undefined}
          >
            {task.title}
          </div>
          {taskTags.length > 0 && (
            <div className="task-tags">
              {taskTags.map(tag => (
                <span key={tag} className="task-tag-chip">{tag}</span>
              ))}
            </div>
          )}
        </div>
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
    );
  };

  return (
    <div className="list-view">
      <div className="list-header">
        <div className="list-title">{t.tasksTitle}</div>
        {done.length > 0 && <button className="clear-btn" onClick={onClearDone}>{t.clearDone}</button>}
      </div>
      <TagFilter items={tasks} active={activeTag} onChange={setActiveTag} allLabel={t.allTagLabel || "הכל"} />
      {onAdd && <NewItemInput kind="task" onSubmit={onAdd} suggestions={tagSuggestions} t={t} />}
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
              {open.map(renderOpenRow)}
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
