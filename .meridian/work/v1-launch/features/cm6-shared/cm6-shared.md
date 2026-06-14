# CM6 Shared Extensions

Reusable CodeMirror 6 plugins shared between the document editor and chat input.

## Scope

Explicit shared runtime layer — these extensions live in a `core/cm6/` package, not scattered across features.

### Shared Extensions
- **@mention autocomplete** — trigger on `@`, fuzzy search, insert mention entity
- **Markdown decorations** — live preview (headings, bold, italic, links, code)
- **Keybindings** — shared keyboard shortcuts (formatting, navigation)
- **Theme** — shared CM6 theme tokens derived from design system

### Editor-Only Extensions
- **Block rendering** — images, code blocks, horizontal rules
- **Collab decorations** — hunk marks, suggestion highlights, review toolbar
- **Focus mode** — dim non-active paragraphs
- **Typewriter scroll** — keep cursor centered

### Chat-Only Extensions
- **@mention chips** — render mentions as inline badges (not wiki links)
- **Compact mode** — smaller font, single-line-friendly layout
- **Submit on Enter** — send message shortcut

## Architecture

```
core/cm6/
├── extensions/
│   ├── mentions.ts        # Shared @mention autocomplete
│   ├── markdown.ts        # Shared markdown decorations
│   ├── keybindings.ts     # Shared keybindings
│   └── theme.ts           # Shared theme
├── editor/                # Editor-specific extensions
└── chat/                  # Chat-specific extensions
```

Lazy-loaded per surface — editor loads editor extensions, chat loads chat extensions. Shared extensions loaded by both.

## Carry Forward

- Existing `frontend/src/core/editor/codemirror/` — CM6 setup
- Existing `frontend/src/core/cm6-collab/` — collab extensions

## Dependencies

- Design system (theme tokens)
- @mentions (mention entity model)
