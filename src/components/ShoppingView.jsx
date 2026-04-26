import { useEffect, useRef, useState } from "react";
import CheckSVG from "./CheckSVG.jsx";
import { EmptyShoppingIcon, DeleteIcon } from "./Icons.jsx";
import TagFilter, { useTagFilter, filterByTag, tagsFromItems } from "./TagFilter.jsx";
import TagChipsEditor from "./TagChipsEditor.jsx";
import NewItemInput from "./NewItemInput.jsx";

// Inline-edit row for shopping items. Mirrors TaskEditRow in TasksView —
// editable name field + tag editor, save on blur/Enter, cancel on Escape.
// Quantity edit is intentionally skipped here; it's rare in the dashboard
// flow (most users add via WhatsApp where qty is already parsed).
function ShoppingEditRow({ item, suggestions, onSave, onCancel }) {
  const [name, setName] = useState(item.name || "");
  const [tags, setTags] = useState(Array.isArray(item.tags) ? item.tags : []);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const next = name.trim();
    if (!next) { onCancel(); return; }
    const nameChanged = next !== (item.name || "");
    const tagsChanged = JSON.stringify(tags) !== JSON.stringify(item.tags || []);
    if (nameChanged || tagsChanged) onSave({ name: next, tags });
    else onCancel();
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="shop-row shop-row-editing">
      <input
        ref={inputRef}
        type="text"
        className="shop-edit-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
      <TagChipsEditor value={tags} onChange={setTags} suggestions={suggestions} compact />
    </div>
  );
}

export default function ShoppingView({ shopping, onToggle, onDelete, onClearGot, onAdd, onUpdate, t, pendingDelete, loading }) {
  const [activeTag, setActiveTag] = useTagFilter();
  const [editingId, setEditingId] = useState(null);

  const visible = filterByTag(shopping, activeTag);
  const need = visible.filter(s => !s.got);
  const got  = visible.filter(s => s.got);
  const grouped = {};
  need.forEach(s => { const c = s.category || t.cats[8]; if (!grouped[c]) grouped[c] = []; grouped[c].push(s); });
  // Render canonical categories first (in their defined order), then any non-canonical category
  // names appended at the end — so if the bot writes a category the app doesn't know yet (e.g.
  // "בשר" instead of "בשר ודגים"), items still render instead of being silently hidden. This
  // prevented Adi Kaye from seeing 6 of her 11 items on 2026-04-15 before we caught it.
  const knownCats = t.cats.filter(c => grouped[c]?.length > 0);
  const unknownCats = Object.keys(grouped).filter(c => !t.cats.includes(c));
  const usedCats = [...knownCats, ...unknownCats];

  const tagSuggestions = tagsFromItems(shopping).map(({ tag }) => tag);

  const renderNeedRow = (s) => {
    if (editingId === s.id) {
      return (
        <ShoppingEditRow
          key={s.id}
          item={s}
          suggestions={tagSuggestions}
          onSave={(patch) => { onUpdate?.(s.id, patch); setEditingId(null); }}
          onCancel={() => setEditingId(null)}
        />
      );
    }
    const itemTags = Array.isArray(s.tags) ? s.tags : [];
    return (
      <div key={s.id} className="shop-row">
        <div className={`shop-check ${s.got?"on":""}`} onClick={() => onToggle(s.id)}>
          <CheckSVG />
        </div>
        <div className="shop-text">
          <div
            className="shop-name shop-name-editable"
            onClick={() => onUpdate && setEditingId(s.id)}
            title={onUpdate ? "tap to edit" : undefined}
          >
            {s.name}
          </div>
          {s.qty && <div className="shop-qty">{t.qtyLabel(s.qty)}</div>}
          {itemTags.length > 0 && (
            <div className="task-tags">
              {itemTags.map(tag => (
                <span key={tag} className="task-tag-chip">{tag}</span>
              ))}
            </div>
          )}
        </div>
        <button className={`del-btn ${pendingDelete?.type === "shop" && pendingDelete?.id === s.id ? "confirming" : ""}`}
            onClick={() => onDelete("shop", s.id)}>{pendingDelete?.type === "shop" && pendingDelete?.id === s.id ? "?" : <DeleteIcon size={14} />}</button>
      </div>
    );
  };

  return (
    <div className="list-view">
      <div className="list-header">
        <div className="list-title">{t.shopTitle}</div>
        {got.length > 0 && <button className="clear-btn" onClick={onClearGot}>{t.clearCart}</button>}
      </div>
      <TagFilter items={shopping} active={activeTag} onChange={setActiveTag} allLabel={t.allTagLabel || "הכל"} />
      {onAdd && <NewItemInput kind="shopping" onSubmit={onAdd} suggestions={tagSuggestions} t={t} />}
      {loading ? (
        <div className="list-empty"><div style={{fontSize:13,color:"var(--muted)",padding:24,textAlign:"center"}}>{(t.loading || "Loading...")}</div></div>
      ) : shopping.length === 0 ? (
        <div className="list-empty">
          <div className="list-empty-icon"><EmptyShoppingIcon size={44} /></div>
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
              {grouped[cat].map(renderNeedRow)}
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
                  {s.category && <div className="cat-badge">{s.category}</div>}
                  <button className={`del-btn ${pendingDelete?.type === "shop" && pendingDelete?.id === s.id ? "confirming" : ""}`}
                      onClick={() => onDelete("shop", s.id)}>{pendingDelete?.type === "shop" && pendingDelete?.id === s.id ? "?" : <DeleteIcon size={14} />}</button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
