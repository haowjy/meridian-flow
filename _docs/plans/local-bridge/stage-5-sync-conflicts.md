---
detail: comprehensive
audience: developer
---

# Stage 5: Bidirectional Sync + Conflicts (Conflict-Safe)

Goal: Avoid data loss when both sides edit.

## Source Of Truth Rule

Do NOT use timestamp-only "last write wins".

Use:
- `lastSyncedHash` (per file/document)
- current app hash
- current disk hash
- timestamps as hints only

## Reconcile Rules

Given `lastSyncedHash`:
- Only app changed -> write app to disk
- Only disk changed -> import disk to app
- Both changed -> conflict (require user action)

## Conflict UX (MVP)

- Editor banner: "File changed on disk"
- Actions:
  - "Use Disk" (overwrite app)
  - "Keep Meridian" (overwrite disk)
  - "Open Diff" (review before choosing)

## Stage Exit Criteria

- No silent data loss on concurrent edits.
- Conflicts are surfaced deterministically.

