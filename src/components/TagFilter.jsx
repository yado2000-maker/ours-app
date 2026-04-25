// Horizontal tag-chip filter row used by TasksView + ShoppingView.
// Free-form user-defined tags (Tier 2 of list-display + free-form tags plan,
// 2026-04-25). The "All" chip is always present; specific-tag chips are sorted
// by usage count desc so the most-used list lands first.
//
// Reads the active tag from URL ?tag=X on mount so deep links from WhatsApp
// (sheli.ai/tasks?tag=עבודה) pre-select the chip. Updates the URL on chip
// change without a full reload (history.replaceState) so back-button still
// returns to the previous app screen, not to the unfiltered list.

import { useEffect, useState } from "react";

function readTagFromUrl() {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("tag");
    if (!raw) return null;
    const decoded = decodeURIComponent(raw).trim().toLowerCase();
    return decoded.length > 0 && decoded.length <= 50 ? decoded : null;
  } catch {
    return null;
  }
}

function writeTagToUrl(tag) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (tag) url.searchParams.set("tag", tag);
    else url.searchParams.delete("tag");
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* no-op */
  }
}

export function useTagFilter() {
  const [active, setActive] = useState(() => readTagFromUrl());
  useEffect(() => {
    writeTagToUrl(active);
  }, [active]);
  return [active, setActive];
}

// Filter helper. items is an array of rows that may have a `tags` array. When
// `active` is null, all items match. When set, only items whose `tags` contain
// the active tag (case-insensitive) match.
export function filterByTag(items, active) {
  if (!active) return items || [];
  const target = String(active).trim().toLowerCase();
  return (items || []).filter((it) => {
    const t = it?.tags;
    if (!Array.isArray(t)) return false;
    return t.some((x) => String(x || "").trim().toLowerCase() === target);
  });
}

// Build a sorted list of distinct tags + counts from a row collection.
// Untagged rows are NOT included (they're always visible under "All").
export function tagsFromItems(items) {
  const counts = new Map();
  for (const it of items || []) {
    const t = it?.tags;
    if (!Array.isArray(t)) continue;
    for (const raw of t) {
      const norm = String(raw || "").trim().toLowerCase();
      if (!norm) continue;
      counts.set(norm, (counts.get(norm) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

export default function TagFilter({ items, active, onChange, allLabel = "הכל" }) {
  const tags = tagsFromItems(items);
  if (tags.length === 0) return null; // no tags in this household → hide chip row entirely

  const totalCount = (items || []).length;

  return (
    <div className="tag-filter-row">
      <button
        className={`tag-chip ${!active ? "tag-chip-active" : ""}`}
        onClick={() => onChange(null)}
        type="button"
      >
        {allLabel} ({totalCount})
      </button>
      {tags.map(({ tag, count }) => (
        <button
          key={tag}
          className={`tag-chip ${active === tag ? "tag-chip-active" : ""}`}
          onClick={() => onChange(active === tag ? null : tag)}
          type="button"
        >
          {tag} ({count})
        </button>
      ))}
    </div>
  );
}
