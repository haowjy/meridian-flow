# features/editor — contracts and architecture

This reference covers the app-facing editor boundary: session binding, review
projection, scope, shared geometry, and peer marks. Read [`AGENTS.md`](../AGENTS.md)
for the short operating rules; core editor contracts remain in `core/editor`.

## Boundary and geometry

`SessionEditor` binds the document session and provides `EditorScopeProvider`.
`EditorView` chooses live or review presentation and registers the app runtimes;
`EditorChromeHost` mounts the surface registry once. The host renders no
surface of its own. A runtime that needs project state returns `null`; visible
outcomes mount through the chrome registry.

`editor-column.ts` is the only owner of prose, toolbar, and canvas geometry.
The toolbar row shares the prose edge, while the identity bar is pane-wide.
`EditorSurfaceFrame` owns the scroll container and past-the-end prose reserve:
a manuscript scrolls until its last line sits in the pane's upper half, so a
writer never types against the bottom edge. The reserve belongs on the
ProseMirror node so blank space remains caret territory (a press there lands
the caret at document end, as a gapcursor after an object). Gutter presses are guarded by the frame and resolved through
`core/editor/pointer-boundary`, using `TextSelection.near` rather than a raw
position.

Measured editor chrome is absolute in the manuscript scroll pane. The pane is
its containing block and clip; viewport coordinates are used only for pointer
input and Radix point anchors. `useAnchorRect` follows the kernel layout
watcher. A missing anchor is null and removes the surface, not a zero rectangle.
Node holds carry document identity through transactions; DOM elements provide
current geometry only.

The document toolbar is persistent document chrome. Contextual controls use
block, link, table, and object surfaces and must not become a second toolbar.
Slash and link completion keep focus in prose and use moving `anchorRect`
anchors. Their rows come from the shared completion/catalog seams.

## Scope and catalogs

`useEditorScope()` reads `{ projectId, workId, rootThreadId }` from the provider.
Project documents use the project's No Work row; Scratch uses the holder's
replica location, including No Work. A No Work Scratch note carries
its lineage in `rootThreadId`. Until the location is known, scope is
unresolved; route `?work`, remembered Work, and `baseUri` are not fallbacks.

Scope drives link catalogs, completion, resolver registration, contextual create,
and link destinations. It is deliberately excluded from `EditorMountIdentity`:
moving a holder must not destroy its collaborative editor or undo manager.
Editor route Work and review Work remain separate authorities.
Live holders take their address from the link catalog. Review holders prefer the
draft review row, because a still-hidden created document is deliberately absent
from the live catalog until Apply; an ordinary review whose row has disappeared
falls back to that same live catalog.

The slash and `[[` catalogs are supplied as getters. They read labels and
catalog contents when a menu opens, so locale changes do not remount the
editor. They return null for read-only/schema-fenced hosts and, for links, for
hosts without a project. Link candidates come from the link resolver's own
index rather than a second document list.

## Review and paint continuity

Review projects the mounted draft text against its server-owned `review_base`, the live text used for comparison. Removed base
text is red and struck; inserted draft text is green, including writer edits.
Attribution supplies bylines without partitioning changes. Removed-text widgets
are not manuscript content. Desktop review is editable; phone review is
read-only. Projection, commands and history belong to the
[draft-review runtime](../../draft-review/.context/draft-review.md).

`DraftReviewProvider` supplies the presented review. Identity/header chrome and
change bars read the shared review projection; `EditorView` does not own a second review
controller. The review controls live in the identity bar's path row (the
`DraftReviewChip` on a live document with a pending draft, the
`DraftReviewBand` in review), with no separate header above it. The focused
change's bar (`surfaces/review`) never covers manuscript text: it sits in the
right margin beside the change when there is room, else in a block slot after
the change's last paragraph. Draft room lifecycle, frozen commands and Discard history belong
to [`draft-review`](../../draft-review/.context/draft-review.md).

`PaintHold` retains finished paint across lifecycle handoffs. Ordinary text
Discard edits the same draft Y.Doc in place, without replacing the editor,
selection or undo manager. An empty review stays in the same draft room.

`useInlineReviewFocus` registers the mounted editor for controller-owned jumps
and releases only its own claim on unmount. Same-entry URL replacements
disable router scroll restoration so editor anchor navigation owns scrolling. Dock/Work rows and their notice paint before
the atomic write-back; editor marks remain derived from actual text.

## Schema and repair

A schema fence changes the mounted editor to read-only through its options seam;
it does not rebuild the editor or undo manager. A schema-stale reset unmounts
it and shows the unavailable state.

Binding waits behind the bounded repair-evidence horizon, then always mounts
(even when evidence timed out). `SchemaRepairNotice` reports witnessed repairs
and can be dismissed locally; it shows every recovered excerpt in full with a
copy button, and never gates editing or offers reinsertion or approval. The notice reads session repair snapshots rather than inspecting the
editor document.

## Peer marks

The peer-mark surface reads the projection plugin's click/Enter/caret state.
The editor feature holds no duplicate mark state. Trail evidence is read-only;
review drafts without a projection naturally stand down. Action controls wait
for trail detail instead of rendering a partial action row. Receipt Undo/Redo
is the sole reversal authority for AI changes. *Open conversation* routes
through `requestConversationReveal`, so the chat side expands the owning turn
receipt; trail-row navigation addresses a matching live session mark first and
falls back to temporary range navigation once it has cleared. Popover focus
follows activation: a pointer open leaves the caret in the prose and a
pointer close restores the held selection; keyboard activation moves focus into
the popover, and Escape or close returns it to the mark's current span. Neither
hands focus back when another surface opened in its place (Mod+K arrives as a
close, and the caret then belongs to what opened).

## Related contracts

- [`surfaces/formatting/.context/CONTEXT.md`](../surfaces/formatting/.context/CONTEXT.md)
- [`surfaces/link/.context/CONTEXT.md`](../surfaces/link/.context/CONTEXT.md)
- [`surfaces/blocks/.context/CONTEXT.md`](../surfaces/blocks/.context/CONTEXT.md)
- [`surfaces/table/.context/CONTEXT.md`](../surfaces/table/.context/CONTEXT.md)
- [`surfaces/objects/.context/CONTEXT.md`](../surfaces/objects/.context/CONTEXT.md)
- [`chrome/.context/CONTEXT.md`](../chrome/.context/CONTEXT.md)
