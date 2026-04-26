// Single-row "add new item" input above each list. Used by TasksView and
// ShoppingView. The text input is always visible; the tag editor folds out
// only when the user wants to attach tags (saves vertical space on mobile).
// Submit on Enter or click the + button. Empty-text submits are ignored.

import { useState } from "react";
import TagChipsEditor from "./TagChipsEditor.jsx";

export default function NewItemInput({ kind, onSubmit, suggestions = [], t }) {
  const [text, setText] = useState("");
  const [tags, setTags] = useState([]);

  const placeholder = kind === "task"
    ? (t?.newTaskPlaceholder || "משימה חדשה")
    : (t?.newShoppingPlaceholder || "פריט חדש");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit({ text: trimmed, tags });
    setText("");
    setTags([]);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="new-item-input">
      <div className="new-item-row">
        <input
          type="text"
          className="new-item-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
        />
        <button
          type="button"
          className="new-item-submit"
          onClick={submit}
          disabled={!text.trim()}
          aria-label="add"
        >
          +
        </button>
      </div>
      <TagChipsEditor
        value={tags}
        onChange={setTags}
        suggestions={suggestions}
        compact
      />
    </div>
  );
}
