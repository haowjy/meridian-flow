# features/chat — Context map

This directory's durable contracts are split by concern so turn rendering and
draft-editing changes can be understood independently.

- [Turn composition](turn-composition.md) — the `Thinking`/`ActivityBlock`
  rendering model, interrupt segmentation, tool rendering, and positional keys.
- [Draft editing](draft-editing.md) — turn edit receipts and undo, composer write
  mode (including Home bootstrap), draft-review freshness, and draft-only tabs.

Shared change-trail shells render as one quiet, collapsed Changes entry at the
transcript tail. They never acquire synthetic turn ownership. A thread-only
conversation reveal scrolls to that entry, expands it, and emphasizes the exact
row; threads without shared shells add no entry.

See [`../AGENTS.md`](../AGENTS.md) for the working mental model and entry points.
