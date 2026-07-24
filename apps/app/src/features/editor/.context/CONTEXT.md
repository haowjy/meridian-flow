# features/editor — contracts and architecture

Reference depth. There is no `AGENTS.md` for this directory yet — the
`EditorToolbar` component is surfaced through the context viewer
(`features/project/context/`), which owns the editor mount host.

## Toolbar — placement contract

The formatting toolbar is a **docked prose-aligned row** above the scroll
area (tab-direction E, settled 2026-07-13 — promoted from the former
"reserve option C"). No card chrome, no rule beneath it: the row is bare
controls sitting on canvas, separated from the prose by whitespace only.

`EditorToolbar` owns the control cluster and command dispatch.
`EditorSurfaceFrame` owns the placement invariant around it: an in-flow
`h-9` row that is a **sibling of the scroll container** (so it stays put
while text scrolls beneath), aligned to the prose column.

**One column, one owner**: `editor-column.ts` is the single home of prose
geometry — the chrome alignment (toolbar row), the canvas wrapper, and
`editorProseClass(toolbar)` for the ProseMirror node (the top inset depends on
whether a docked toolbar already supplies the breathing room; hosts choose at
editor creation). Tracked and untitled documents share this column exactly, so
nothing moves when an untitled tab materializes. Never re-encode these classes
at a call site. (The document identity bar deliberately does NOT share the
column: it is pane-wide navigation chrome, like the tab strip.)

Prose canvases carry no `focus-ring`: the caret is the focus indicator, and
the control-style ring always fires on autofocused surfaces.

## Draft chrome

Two self-contained surfaces, both resolving their own state from
`DraftReviewProvider` (never props-drilled):

- `DraftReviewChip` — the pending-changes nudge, mounted by the context
  feature's `DocumentIdentityBar` in the breadcrumb row. Hides itself while
  its document is under inline review.
- `DraftReviewHeader` — the review-mode strip, rendered by `ContextViewer`
  ABOVE the identity bar (order: tab strip → review strip → identity bar →
  toolbar → prose). Matches the DraftDock strip's geometry and tone
  (`min-h-7`, `bg-dock-surface`, `text-caption`); destructive verb left,
  jade primary pill far right — the same order as the dock.

The chip and header are mutually exclusive by the chip's own inline-review
check, not by a shared slot. (The former `EditorBannerSlot`/`belowToolbar`
tenancy mechanism was deleted 2026-07-21 when the review strip moved above
the identity bar.)

### Rejected placements

| Placement | Reason rejected |
|---|---|
| Floating card pinned top-left (2026-07-13 → tab-direction E) | Card chrome broke the no-lines stack; overlay covered the first line and needed a `pt-16` reserve |
| Centered over the page | Balanced but least connected to chrome or text; still covers first line |
| Corner-right palette | Out of the writing path but further from reach |
| Full-width strip above editor (pre-`e4cd4e66`) | Mismatched the centered text column; read as stray chrome |

## Component API

`EditorToolbar` is the canonical formatting control cluster (H1 / B /
I / code / list / link / figure). It subscribes to the editor's selection and
transaction events to keep active-mark highlighting in sync.

Props:

- `editor: Editor | null` — the TipTap instance. `null` is valid (pre-mount shell).
- `figureUpload*` — delegates back to the host for the file-input flow.

`EditorSurfaceFrame` accepts the optional `toolbar`, the host-specific
`toolbarPositionClassName`, scrolling content, and the tracked editor's optional
scroll class/ref/handler. The frame owns every shared vertical, scroll, and
prose-trim rule; hosts own their content and horizontal coordinate strategy.

Passing the optional `editor` makes the whole scroll area click-to-focus
territory: gutter presses place the caret at the nearest text position —
always through `TextSelection.near`, never a raw `posAtCoords` position,
which can be a block boundary that parks the selection at doc level and
makes remote collab cursors render as a phantom row between paragraphs.
Presses on interactive or live-status children inside the scroller keep
native behavior; both hosts opt in.

## Peer mark popover

`PeerMarkPopover.tsx` is the anchored detail-and-recovery surface for one live
session peer mark. The marker projection itself (`SessionMarkerStore` +
`PeerMarkerExtension`) lives in
[`core/editor`](../../../core/editor/.context/CONTEXT.md); this component is
editor-host chrome, not a ProseMirror plugin.

`EditorView`'s click and keyboard handlers resolve the closest
`[data-peer-mark]` element to a live `SessionMarker` from the session's
`markerStore` and set it as the popover target; the popover is suppressed
during inline draft review (`inReview`), since markers are a live-document
surface and branch rooms have a different anchor space.

Detail is lazy on open: it reads the trail detail endpoint and the originating
thread snapshot, then renders the removed text, a one-line originating-request
snippet, and the trail row's same `Restore` / `Delete again` forward action.
Recovery calls `applyTrailForwardAction` and removes the session mark only after
a successful `applied` / `already_applied` result; a failed action stays
failed with a retry affordance. *Open conversation* routes through
`requestConversationReveal` (see [features/chat](../../chat/AGENTS.md)): the
popover closes and the chat side expands the owning turn Changes card, or the
thread-tail shared Changes entry when the trail has no owning turn, then
emphasizes the exact row.

Trail-row navigation addresses a matching live session mark first, preserving
its range/tick/seam anatomy and emphasis treatment. Generic temporary range
navigation remains the fallback after that mark has cleared or expired.

Popover focus follows activation. Pointer open prevents Radix autofocus and
pointer close restores the captured editor selection and caret. Keyboard
activation moves focus into the popover; Escape/close returns focus to the mark.

## Deferred

- **Block-level `+` gutter handle** ("Turn into" / "Insert" menu on the
  current paragraph). Additive to the formatting toolbar, never a
  replacement. A real build, parked for a future slice.
- **Fade-on-scroll** for the toolbar row. New interaction behavior
  (fade in on focus, slide away in flow) → its own slice; placement
  settles first.
