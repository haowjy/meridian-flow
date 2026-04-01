# Converse Mode: Simplified Document Panel

**Status:** draft

## Problem

The Converse v3 design has a nested tree+editor split in the right document panel. This is too heavy for a chat-first mode. The tree occupies ~25% of the documents panel permanently, wasting space and adding navigational complexity when the writer is primarily engaged in conversation.

## Solution: Single-View Panel with Push/Replace Navigation

The right panel becomes a SINGLE VIEW that swaps between two states, similar to how mobile Converse already works (push/pop navigation) but rendered as a desktop side panel.

### State 1: File Explorer (default)

When no document is open, the panel shows the project file tree full-width.

```
┌─────────────────────────────────────────────────────┐
│  Rail │  Chat (primary, ~50%)   │  Documents (~50%) │
│  48px │                         │  ┌──────────────┐ │
│       │  messages               │  │ Documents    │ │
│  [A]  │                         │  │              │ │
│  [C]  │                         │  │ chapters/    │ │
│  [S]  │                         │  │   ch-01.md   │ │
│       │                         │  │   ch-02.md   │ │
│       │  ┌───────────────────┐  │  │ characters/  │ │
│       │  │ composer          │  │  │   wei-lin.md │ │
│       │  └───────────────────┘  │  │ notes/       │ │
│       │                         │  └──────────────┘ │
├───────┴─────────────────────────┴───────────────────┤
│ Status Bar                                          │
└─────────────────────────────────────────────────────┘
```

- Same file tree component as Studio's explorer (shared, mode-agnostic)
- Click a file to transition to State 2
- Panel header: "Documents" in 14px Geist semibold
- No tabs, no editor chrome, no split panes

### State 2: Active Document

When a document is selected, the panel shows it full-width with navigation controls.

```
┌─────────────────────────────────────────────────────┐
│  Rail │  Chat (primary, ~50%)   │  Document (~50%)  │
│  48px │                         │  ┌──────────────┐ │
│       │  messages               │  │ ← ch-5.md [LP|S] │
│  [A]  │                         │  │ ch-4 wei-lin mag │
│  [C]  │                         │  │              │ │
│  [S]  │                         │  │  (document   │ │
│       │                         │  │   content    │ │
│       │  ┌───────────────────┐  │  │   in iA      │ │
│       │  │ composer          │  │  │   Writer)    │ │
│       │  └───────────────────┘  │  │              │ │
│       │                         │  └──────────────┘ │
├───────┴─────────────────────────┴───────────────────┤
│ Status Bar                                          │
└─────────────────────────────────────────────────────┘
```

**Toolbar** (~36px):
- Back arrow (PhosphorArrowLeft) returns to file explorer
- Filename in 14px Geist semibold
- Editor mode segmented control: Live Preview | Source (pill-shaped, 28px, room for future Preview tab)

**MRU Strip** (~28px):
- Compact horizontal row of recently opened document pills
- Each pill: bg-muted rounded-[4px] px-2 py-0.5 text-xs
- Active pill has subtle teal left accent
- Dismiss X on hover
- Ordered by most recently accessed
- Clicking a pill replaces the current document (push/replace, no stacking)

**Document Content** (remaining height):
- Full-width in panel, iA Writer Quattro, 68ch column centered
- Same editor component as Studio (shared, mode-agnostic)

## Navigation Model

The panel uses **push/replace** navigation, not stacking:

1. Default state: file explorer
2. Click file -> replaces explorer with document view
3. Click back arrow -> replaces document with explorer
4. Click MRU pill -> replaces current document with selected one
5. Click document reference in chat -> replaces whatever is active with referenced doc
6. AI references a document in response -> clicking opens it here

This is intentionally simpler than Studio's tabbed editor. Converse is chat-first; the document panel is for quick reference and light editing, not multi-document workflow.

## MRU (Most Recently Used) Behavior

- Tracks last N documents opened in this session (N = ~8 for the visible strip)
- LRU cache keeps documents in memory for instant switching (no re-fetch)
- Strip scrolls horizontally if more pills than visible width
- MRU list persists per project session (survives mode switches, cleared on project switch)
- Same MRU list used whether opening from explorer, from chat references, or from MRU pills

## Why Single-View, Not Tree+Editor

| Concern | Tree+Editor (old) | Single-View (new) |
|---------|-------------------|-------------------|
| Space efficiency | Tree wastes 25% of panel permanently | Full width for either tree or document |
| Cognitive load | Two sub-panels to manage while chatting | One thing at a time |
| Mobile consistency | Desktop and mobile are completely different navigation models | Desktop mirrors mobile's push/pop pattern |
| Common case | Writer opens 1-2 docs during a conversation | Optimized for this: MRU gives fast access to recent docs |
| Power case | Writer needs to browse many files | Back arrow to explorer is one click away |

## Chat-Triggered Document Opening

When the AI references a document (via reference pills or inline links), clicking opens that document in the panel:

- If panel is showing explorer: push to document view
- If panel is showing a different document: replace with referenced doc (old doc goes to MRU)
- If panel is collapsed: expand and show document

This makes the document panel feel like a live companion to the conversation.

## SuperDesign References

| State | Draft ID | Preview |
|-------|----------|---------|
| State 1: File Explorer | `2f83e262-66f6-4ebe-a968-57648a0f3a74` | [Preview](https://p.superdesign.dev/draft/2f83e262-66f6-4ebe-a968-57648a0f3a74) |
| State 2: Active Document | `4d7cfb1c-e953-4961-bc8b-37c71d840edd` | [Preview](https://p.superdesign.dev/draft/4d7cfb1c-e953-4961-bc8b-37c71d840edd) |

## Cross-References

- [Layout Architecture](layout-architecture.md) -- panel sizing and state scoping
- [Visual Designs](visual-designs.md) -- all design draft links
- [Visual Component Map](../design-system/visual-component-map.md) -- shared component specs
