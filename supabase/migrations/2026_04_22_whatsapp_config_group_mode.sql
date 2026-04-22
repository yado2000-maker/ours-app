-- Phase 6 of Sheli-in-Groups: dedicated-Sheli-group auto-detection.
-- Groups whose name contains "שלי" AND have address-ratio ≥40% (addressed
-- messages / total messages over first 50 msgs) get promoted to
-- group_mode='dedicated_sheli'. In that mode the matrix router loosens
-- ambient suppression so Sheli can be chattier in groups that are
-- explicitly about her. Default 'family_chat' preserves current behavior
-- for every existing group.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS group_mode TEXT NOT NULL DEFAULT 'family_chat'
  CHECK (group_mode IN ('family_chat', 'dedicated_sheli'));
