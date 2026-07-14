# features/editor — contracts and architecture

Reference depth. There is no `AGENTS.md` for this directory yet — the
`FloatingEditorToolbar` component is surfaced through the context viewer
(`features/project/context/`), which owns the editor mount host.

## Floating toolbar — placement contract

The formatting toolbar is a **pinned floating card, top-left** within
the text column. `FloatingEditorToolbar` owns the content-hugging card chrome
(`rounded-md border bg-surface-warm shadow-card`) and its formatting commands.
`EditorSurfaceFrame` owns the placement invariant around it: relative body,
pinned sibling overlay, pointer-event handoff, scrolling slot, and the
toolbar-present `pt-16` prose reserve.

**Shared by all editor surfaces**: `EditorView` (tracked documents) and
`TempDocumentEditor` both mount `FloatingEditorToolbar`. Each host
supplies only the horizontal position within its own coordinate system:

| Host | Card container | Effect |
|---|---|---|
| `EditorView` | `inset-x-0 mx-auto w-full max-w-3xl px-8…` | Left-aligned at the text column's start |
| `TempDocumentEditor` | `left-6 md:left-10` | Pinned to the left edge of the editor padding |

The card is **pinned**: the frame's overlay is a sibling of the scroll
container, not inside it, so it stays in place while text scrolls beneath.
Passing a toolbar makes the frame reserve `pt-16` on the ProseMirror node;
omitting it removes that reserve. `EditorView` routes both its pending and live
mount states through one `TrackedEditorCanvas`, preventing a visible layout
jump between them.

### Rejected placements

| Placement | Reason rejected |
|---|---|
| Centered over the page | Balanced but least connected to chrome or text; still covers first line |
| Corner-right palette | Out of the writing path but further from reach |
| Full-width strip above editor (pre-`e4cd4e66`) | Mismatched the centered text column; read as stray chrome |

### Reserve

**Docked column-aligned strip** (option C): keep a strip but align it to
the prose column. Held in reserve — if the floating card ever feels like
too much chrome, the docked strip is the fallback, not a reversion to the
old full-width strip.

## Component API

`FloatingEditorToolbar` is the canonical formatting control cluster (H1 / B /
I / code / list / link / figure). It subscribes to the editor's selection and
transaction events to keep active-mark highlighting in sync.

Props:

- `editor: Editor | null` — the TipTap instance. `null` is valid (pre-mount shell).
- `figureUpload*` — delegates back to the host for the file-input flow.

`EditorSurfaceFrame` accepts the optional `toolbar`, the host-specific
`toolbarPositionClassName`, scrolling content, and the tracked editor's optional
scroll class/ref/handler. The frame owns every shared vertical, overlay,
pointer-event, scroll, and reserve rule; hosts own their content and horizontal
coordinate strategy.

## Deferred

- **Block-level `+` gutter handle** ("Turn into" / "Insert" menu on the
  current paragraph). Additive to the formatting toolbar, never a
  replacement. A real build, parked for a future slice.
- **Fade-on-scroll** for the floating card. New interaction behavior
  (fade in on focus, slide away in flow) → its own slice; placement
  settles first.
