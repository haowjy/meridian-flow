# features/editor — contracts and architecture

Reference depth. There is no `AGENTS.md` for this directory yet — the
`EditorToolbar` component is surfaced through the context viewer
(`features/project/context/`), which owns the editor mount host.

## FloatingEditorToolbar — placement contract

The formatting toolbar is a **pinned floating card, top-left** within
the text column. `FloatingEditorToolbar` wraps `EditorToolbar` in the
card chrome (`rounded-md border bg-surface-warm shadow-card`) and
`pointer-events-auto` so it remains interactive inside the editor's
`pointer-events-none` overlay layer.

**Shared by all editor surfaces**: `EditorView` (tracked documents) and
`TempDocumentEditor` both mount `FloatingEditorToolbar`. Each host
positions the card within its own coordinate system:

| Host | Card container | Effect |
|---|---|---|
| `EditorView` | `absolute inset-x-0 top-3 mx-auto w-full max-w-3xl px-8…` | Left-aligned at the text column's start |
| `TempDocumentEditor` | `absolute top-3 left-6 md:left-10` | Pinned to the left edge of the editor padding |

The card is **pinned**: the overlay is a sibling of the scroll container,
not inside it, so it stays in place while text scrolls beneath. Both hosts
reserve `pt-16` on the ProseMirror node (`EditorView` only while
`showToolbar`) so no text line starts hidden behind the card.

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

## EditorToolbar — component API

`EditorToolbar` is the inner formatting control cluster (H1 / B / I /
code / list / link / figure). It subscribes to the editor's selection and
transaction events to keep active-mark highlighting in sync. Owns only
the toolbar chrome and command dispatch.

Props:

- `editor: Editor | null` — the TipTap instance. `null` is valid (pre-mount shell).
- `className` — overrides the root layout (`w-auto` for card context, `w-full` for the legacy full-width strip).
- `showHint` — toggles the trailing `/figure…` slash hint. Off for floating card mounts.
- `figureUpload*` — delegates back to the host for the file-input flow.

`FloatingEditorToolbar` is a convenience wrapper that hardcodes `className="w-auto"` and `showHint={false}`.

## Deferred

- **Block-level `+` gutter handle** ("Turn into" / "Insert" menu on the
  current paragraph). Additive to the formatting toolbar, never a
  replacement. A real build, parked for a future slice.
- **Fade-on-scroll** for the floating card. New interaction behavior
  (fade in on focus, slide away in flow) → its own slice; placement
  settles first.
