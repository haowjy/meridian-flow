# features/chat — Context map

This directory's durable contracts are split by concern so turn rendering and
draft-control changes can be understood independently.

- [Turn composition](turn-composition.md) — the `Thinking`/`ActivityBlock`
  rendering model, interrupt segmentation, tool rendering, and positional keys.
- [Turn edit receipts](turn-edit-receipts.md) — committed change records, Undo/Redo,
  and conversation reveal.
- [Composer write mode](composer-write-mode.md) — the Work-scoped Draft /
  Auto-apply control, confirmation, Home bootstrap, and composer sizing.
- [Draft review](draft-review.md) — inline review session, pending projection,
  freshness, and draft-only tabs.

Durable change detail renders only through the owning turn receipt; the
transcript does not add a conversation-wide aggregate record.

See [`../AGENTS.md`](../AGENTS.md) for the working mental model and entry points.
