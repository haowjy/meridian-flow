# features/chat — Context map

This directory's durable contracts are split by concern so turn rendering and
draft-editing changes can be understood independently.

- [Turn composition](turn-composition.md) — the `Thinking`/`ActivityBlock`
  rendering model, interrupt segmentation, tool rendering, and positional keys.
- [Draft editing](draft-editing.md) — turn edit receipts and undo, composer write
  mode (including Home bootstrap), draft-review freshness, and draft-only tabs.

Durable change detail renders only through the owning turn receipt; the
transcript does not add a conversation-wide aggregate record.

See [`../AGENTS.md`](../AGENTS.md) for the working mental model and entry points.
