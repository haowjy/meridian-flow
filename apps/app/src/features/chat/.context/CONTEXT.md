# features/chat — Context map

This directory's durable contracts are split by concern so turn rendering and
draft-editing changes can be understood independently.

- [Turn composition](turn-composition.md) — the `Thinking`/`ActivityBlock`
  rendering model, interrupt segmentation, tool rendering, and positional keys.
- [Draft editing](draft-editing.md) — turn edit receipts and undo, composer write
  mode (including Home bootstrap), draft-review freshness, and draft-only tabs.

See [`../AGENTS.md`](../AGENTS.md) for the working mental model and entry points.
