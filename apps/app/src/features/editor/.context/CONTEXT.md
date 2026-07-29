# features/editor — contracts and architecture

Reference depth for the app-facing editor surface. Read
[`AGENTS.md`](../AGENTS.md) first.

## One persistent surface, no contextual bubbles

The document toolbar is the only chrome that persists, and it never overlays
the text: `EditorSurfaceFrame` docks it in a prose-aligned row above the
scroll area, and `EditorView` decides whether a host gets one at all
(read-only phone documents do not). Everything it can do is document-level;
the contextual surfaces that replace the deleted bubbles anchor to the block
they serve and belong to the rebuild, not to incremental patches here. See
[`surfaces/toolbar/AGENTS.md`](../surfaces/toolbar/AGENTS.md).

The rest of this surface is the prose column, the sync indicator, the
image-upload flow, and the notice/popover surfaces below.

Block alignment is a shared command module, not the toolbar's own:
`block-alignment.ts` resolves every alignable block a selection touches (a
table counts as one, never its cells) and writes to all of them, so selecting
three paragraphs and pressing Center centers three paragraphs.

**One column, one owner**: `editor-column.ts` is the single home of prose
geometry — the chrome row inset, the canvas wrapper, and `editorProseClass`
for the ProseMirror node. The toolbar row's inset equals the canvas inset plus
the prose inset, so the first control sits exactly above the first character;
that sum is the invariant the file documents. `editorProseClass` takes the
toolbar state because a docked row already provides the top breathing room.
Tracked and untitled documents share this column exactly, so nothing moves when
an untitled tab materializes. Never re-encode these classes at a call site.
(The document identity bar deliberately does NOT share the column: it is
pane-wide navigation chrome, like the tab strip.)

The bottom padding (`pb-[50vh]`) on the ProseMirror node is deliberate: it
keeps the active writing line near the vertical center of the viewport in long
manuscripts, and makes clicking below the last line focus the editor at the
document end. This padding lives in `editorProseClass`, not in editor CSS —
it is geometry, owned by `editor-column.ts`.

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
  prose). Matches the DraftDock strip's geometry and tone
  (`min-h-7`, `bg-dock-surface`, `text-caption`); destructive verb left,
  jade primary pill far right — the same order as the dock.

The chip and header are mutually exclusive by the chip's own inline-review
check, not by a shared slot.

The review manuscript is the server draft projection, not a track-changes
composition. Inline decorations may style ranges that exist in that projection,
but must not inject deleted live prose or blocks. Zero-content seams mark
pure-deletion locations for visible Changes-card navigation. Before/after
content belongs in the dock's Changes cards. The review editor stays editable:
the draft is a Yjs room and the writer is one more peer in it, so keystrokes in
review land in the draft branch rather than live. The review header is the
visible signal that the draft surface is active.

### Rejected placements

| Placement | Reason rejected |
|---|---|
| Floating card pinned top-left | Card chrome broke the no-lines stack; overlay covered the first line and needed a `pt-16` reserve |
| Centered over the page | Balanced but least connected to chrome or text; still covers first line |
| Corner-right palette | Out of the writing path but further from reach |
| Full-width strip above editor | Mismatched the centered text column; read as stray chrome |

## Component API

### Command modules the surfaces consume

`block-alignment.ts`, `link-selection.ts`, and `core/editor/table-operations.ts`
outlived the chrome that called them and are the command and resolution layer
the rebuilt surfaces consume. The toolbar uses the first two; the third waits
for the table surfaces.

`linkAttributesAtSelection` exists because `editor.isActive("link")` can miss an
empty selection at a mark boundary, notably the link's start. It uses
`getMarkRange` for carets so a link control stays available at either edge. Any
control that opens on a mark-touching caret should resolve the same way rather
than gating on `isActive` alone.

### Slash insertion catalog

`EditorView` owns the nine-item catalog and hands `useMountedEditor` a *getter*,
never the catalog itself. The extension mounts as a construction fact; its
localized labels and the image-upload callback are read when the menu opens, so
a locale switch relabels the menu instead of appearing in `EditorMountIdentity`
and remounting the editor. The seam is live; the trigger that consumed it is
not, so nothing reads the catalog until the rebuild lands a trigger.

`EditorSurfaceFrame` accepts scrolling content and the tracked editor's optional
scroll class/ref/handler. The frame owns every shared vertical, scroll, and
prose-trim rule; hosts own their content and horizontal coordinate strategy.

Passing the optional `editor` makes the whole scroll area click-to-focus
territory: gutter presses place the caret at the nearest text position —
always through `TextSelection.near`, never a raw `posAtCoords` position,
which can be a block boundary that parks the selection at doc level and
makes remote collab cursors render as a phantom row between paragraphs.
Presses on interactive or live-status children inside the scroller keep
native behavior; both hosts opt in.

## Schema fence

`EditorView` subscribes to its `DocumentSessionSnapshot` and derives live
editability as the caller's `editable` input AND the absence of
`snapshot.schemaFence`. A fence raised after mount reaches the existing
`useMountedEditor()` surface-options seam, which calls `setEditable(false)`
without rebuilding the editor or its UndoManager.

A fence disables the mounted editor and renders `SchemaFenceNotice`. A
`document-schema-stale` reset unmounts the editor and renders the unavailable
state.

## Schema repair report

`EditorView` delays binding behind the bounded evidence horizon and renders the
existing pending shell while it waits. A timeout degrades evidence but always
continues into an editable mount.

`SchemaRepairNotice` is separate from fence chrome because a witnessed repair
never gates editing. It coalesces the session's
`DocumentSessionSnapshot.schemaRepairs`, shows every recovered excerpt in full
with a copy button, and dismisses locally until another verdict arrives. The
surface is deliberately unstyled and has no reinsertion or approval action.

## Peer mark popover

`PeerMarkPopover.tsx` is the anchored evidence surface for one live
session peer mark. The marker projection itself (`SessionMarkerStore` +
`PeerMarkerExtension`) lives in
[`core/editor`](../../../core/editor/.context/CONTEXT.md); this component is
editor-host chrome, not a ProseMirror plugin.

`EditorView`'s click and keyboard handlers resolve the closest
`[data-peer-mark]` element to a live `SessionMarker` from the session's
`markerStore` and set it as the popover target; the popover is suppressed
during inline draft review (`inReview`), since markers are a live-document
surface and branch rooms have a different anchor space.

Detail comes from the shared trail-detail cache in
[`features/change-trail`](../../change-trail/AGENTS.md). `EditorView` prefetches
it for every agent mark on screen, so the popover normally opens with its
evidence already available; while a first read is genuinely in flight the
actions row is withheld rather than rendered half-empty, and only actor and
time show. The resting surface contains actor, time, and conversation
navigation. A single Before/After control reveals the same trail-backed excerpt
renderer used by the turn receipt; swept status adds no popover narration.
Trail evidence is read-only: receipt Undo/Redo is the sole reversal authority
for AI changes. *Open conversation* routes through
`requestConversationReveal` (see [features/chat](../../chat/AGENTS.md)): the
popover closes and the chat side expands the owning turn receipt and brings the
exact row into view.

Trail-row navigation addresses a matching live session mark first, preserving
its range/tick anatomy and emphasis treatment. Generic temporary range
navigation remains the fallback after that mark has cleared or expired.

Popover focus follows activation. Pointer open prevents Radix autofocus and
pointer close restores the captured editor selection and caret. Keyboard
activation moves focus into the popover; Escape/close returns focus to the mark.
