# Operator recovery DM templates

Hand-sent by Yaron (or another operator) when reaching back out to a beta user
after Sheli misbehaved. **Never auto-sent.** These are not staged in
`outbound_queue` — they go through a 1:1 chat the operator personally opens.

## Bat-Chen 2026-04-18 — list display + duplicate re-add incident

Context: 60-min Saturday conversation where 51 tasks landed in DB but Sheli's
WhatsApp replies truncated mid-line, the user read it as data loss, complained
"שכחת משימות", Sheli blind-re-added (instead of comparing), DB bloated with
duplicates, the next display still looked incomplete. User said "את לא עובדת
כל כך טוב" and gave up.

The Tier 1 hot-fix (already shipped) addresses the truncation + blind-re-add
loop. Tier 2 (this PR) adds proper tag/list separation. Tier 3.1 (deferred)
will dedupe Bat-Chen's `hh_batchen_recov` rows. Send this DM only after Tier
3.1 has been applied AND the user re-engages on her own — do not cold-message
her.

```
היי בת חן, סורי על הבלגן בשבת.
סידרתי הכל אצלי — הרשימות מחולקות נכון, התאריכים יושבים על המשימות.
הכל פה: sheli.ai 📋
```

Notes for the operator:
- Singular "סורי" + "סידרתי" matches Sheli's voice (1st person feminine).
- Do NOT mention "באג" / "תיקנתי באג" — Tier 1's NO-FAKE-BUG rule applies to
  operator messages too. The honest framing is "I cleaned things up", not "I
  fixed a bug that ate your data".
- Single URL on its own line, no `ב-sheli.ai` (RTL flip + URL auto-detect).
- If she replies asking what changed, the honest answer is: "הוספתי תווית
  לרשימות שלך כדי שלא יתערבבו, וניקיתי כפילויות שנכנסו בשבת."

## Future incidents

When adding a new template here, follow the same pattern:
1. Name it for the user + the date the incident happened.
2. Brief context paragraph (what failed, why, what was fixed).
3. The literal Hebrew DM, fenced.
4. Operator notes: voice rules, what NOT to say, expected follow-up phrasing.
