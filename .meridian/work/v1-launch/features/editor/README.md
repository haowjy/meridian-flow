---
detail: minimal
audience: developer
---

# Editor Documentation

| Doc | Purpose |
|-----|---------|
| [cm6-architecture.md](./cm6-architecture.md) | Core CM6 setup, compartments, tab system, state management, performance, pitfalls |
| [decorations.md](./decorations.md) | Decoration system, reveal mode, interaction model, context menu |
| [editor-collab.md](./editor-collab.md) | Yjs binding, CRDT constraints, undo/redo |
| [keyboard-shortcuts.md](./keyboard-shortcuts.md) | Shortcut map, paste handling, accessibility |
| [editor-direction.md](./editor-direction.md) | Strategic decisions and product direction |
| [editor-strategy.md](./editor-strategy.md) | Implementation strategy |
| [editor-refactor-design.md](./editor-refactor-design.md) | Full refactor architecture — SessionPool, ViewController, DocSession |
| [decisions.md](./decisions.md) | Key architecture decisions with rationale (Yjs-first, no value prop, etc.) |

## Source Location

`frontend-v2/src/editor/`

| Subdir | Contents |
|--------|----------|
| `decorations/` | ViewPlugin + StateField decoration files |
| `interaction/` | Context menu, event handlers, CM6-React bridge |
| `tabs/` | LRU tab manager, TabBar component |
| `title-header/` | TitleHeader, ConnectionStatus, WordCount, RenameInput |
| `export/` | ExportDropdown, client-side exporters |
| `formatting/` | Formatting keymap, toggleWrap |
| `paste/` | Paste handler, HTML-to-markdown converter |
| `collab/` | Yjs binding, remote cursors, undo manager, IDB persistence |
| `content/` | Pull-based content API |
| `stories/` | Storybook demos |
