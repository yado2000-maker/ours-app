// Multi-select tag editor for inline task/shopping edit + the new-item input.
// Renders the current tag set as removable chips + a "+" chip that opens a
// small input for adding either an existing tag (autocomplete from suggestions)
// or a brand-new free-form one. Normalization mirrors the bot-side
// normalizeTags helper: trim → lowercase → drop empty → drop length>50.
//
// Keys:
//   Enter / Tab / "," → commit current input as a tag
//   Escape            → cancel the input (doesn't delete existing chips)
//   Backspace on empty → remove the last chip (quick keyboard editing)

import { useEffect, useRef, useState } from "react";

const MAX_LEN = 50;

function normalize(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

export default function TagChipsEditor({
  value,
  onChange,
  suggestions = [],
  placeholder = "+ נושא",
  compact = false,
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const tags = Array.isArray(value) ? value : [];

  const addTag = (raw) => {
    const norm = normalize(raw);
    if (!norm || norm.length > MAX_LEN) {
      setDraft("");
      setAdding(false);
      return;
    }
    if (tags.includes(norm)) {
      setDraft("");
      setAdding(false);
      return;
    }
    onChange([...tags, norm]);
    setDraft("");
    setAdding(false);
  };

  const removeTag = (tag) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      e.preventDefault();
      addTag(draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft("");
      setAdding(false);
    } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      e.preventDefault();
      removeTag(tags[tags.length - 1]);
    }
  };

  // Filtered suggestions: ones matching the current draft (case-insensitive),
  // not already applied. Cap at 6 so the popover stays compact.
  const draftLower = draft.toLowerCase();
  const filteredSuggestions = (suggestions || [])
    .map(normalize)
    .filter((s) => s && !tags.includes(s) && s.includes(draftLower))
    .slice(0, 6);

  return (
    <div className={`tag-editor ${compact ? "tag-editor-compact" : ""}`}>
      {tags.map((tag) => (
        <span key={tag} className="tag-chip tag-chip-editable">
          {tag}
          <button
            type="button"
            className="tag-chip-x"
            onClick={() => removeTag(tag)}
            aria-label={`remove ${tag}`}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <span className="tag-chip tag-chip-input-wrap">
          <input
            ref={inputRef}
            type="text"
            className="tag-chip-input"
            value={draft}
            maxLength={MAX_LEN}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (draft.trim()) addTag(draft);
              else setAdding(false);
            }}
            placeholder={placeholder.replace(/^\+\s*/, "")}
          />
          {filteredSuggestions.length > 0 && (
            <span className="tag-suggestions">
              {filteredSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tag-suggestion"
                  onMouseDown={(e) => {
                    // mousedown not click — fires before blur, so the suggestion
                    // commits before the input loses focus.
                    e.preventDefault();
                    addTag(s);
                  }}
                >
                  {s}
                </button>
              ))}
            </span>
          )}
        </span>
      ) : (
        <button
          type="button"
          className="tag-chip tag-chip-add"
          onClick={() => setAdding(true)}
        >
          {placeholder}
        </button>
      )}
    </div>
  );
}
