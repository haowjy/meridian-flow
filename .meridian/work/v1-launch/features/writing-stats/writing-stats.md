# Writing Stats

> **Status: Cut from v1 scope. See post-v1 roadmap.**

Session-level and project-level writing statistics.

## Scope

- **Session word count** — words written since session start, visible in status bar
- **Daily word count** — today's total, with history chart
- **Writing streaks** — consecutive days with writing activity
- **Per-document word count** — shown in explorer alongside document name
- **Deadline projection** — "At current pace, you'll finish by X" (optional, user sets target)

## Implementation

- Word count: computed client-side from document content (no server round-trip)
- Session tracking: start time stored in localStorage, word count diff computed
- History: daily aggregates stored in Dexie (lightweight, local-first)
- Status bar widget: compact display, click to expand detail view

## Future (post-v1)

- Writing speed (WPM during active sessions)
- Per-chapter analytics
- Export stats as CSV
- Streaks with notifications/gamification

## Dependencies

- Design system (status bar widget, chart component)
- Editor (word count source)
