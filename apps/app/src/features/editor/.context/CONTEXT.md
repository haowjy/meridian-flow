# features/editor — contracts and architecture

This reference covers the app-facing editor boundary: session binding, review
projection, scope, shared geometry. Read [`AGENTS.md`](../AGENTS.md)
for the short operating rules; core editor contracts remain in `core/editor`.

## Boundary and geometry

`SessionEditor` binds the document session and provides `EditorScopeProvider`.
`EditorView` mounts one `SessionEditor` over the room its host bound (Live, or a
draft's fork) or `PendingEditorShell` while none is bound; there is no separate review
presentation to choose. `SessionEditor` provides `EditorScopeProvider`, mounts
`EditorChromeHost` (the surface registry, once), and mounts the link, image and file-drop
runtimes. The host renders no surface of its own. A runtime that needs project state returns `null`; visible
outcomes mount through the chrome registry.

`editor-column.ts` is the only owner of prose, toolbar, and canvas geometry.
The toolbar row shares the prose edge, while the identity bar is pane-wide.
`EditorSurfaceFrame` owns the scroll container and past-the-end prose reserve:
a manuscript scrolls until its last line sits in the pane's upper half, so a
writer never types against the bottom edge. The reserve belongs on the
ProseMirror node so blank space remains caret territory (a press there lands
where the walk in `core/editor/landing` says). The ProseMirror
node spans the whole pane and carries the margin as its own padding, so gutter
presses and drops are the editor's own: `core/editor/landing` resolves the
presses with no text under them and every drop, and the frame only sets the
cursor.

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

Word count reads `selection.from..to` (a multi-range selection, such as a cell
rectangle, counts only that span). Selected counts update when content changes even if the
selection stays equal.

## Scope and catalogs

`useEditorScope()` reads `{ projectId, workId, rootThreadId }` from the provider.
Project documents use the project's No Work row; Scratch uses the holder's
the source its document is in (the tree's, found by id), including No Work. A No Work Scratch note carries
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

A Draft view edits the draft's fork room of the document (`registry.admit` with the draft's id),
as Live's view edits the Live room. Projection, commands and history belong to the
[draft-review runtime](../../draft-review/.context/draft-review.md).

Each document host (main, the side, the phone) has its own review
(`features/project/DocumentReview.tsx`), and `EditorView` owns none. The version chip
(`DocumentVersionMenu`, Live with every draft one pick away) sits at the toolbar row's end on
desktop and phone alike, beside "Review N changes" on a plain draft. Review changes paints in the
editor (`core/editor/extensions/review-changes`, mounted by `surfaces/review`): Live's text of each
changed paragraph above the draft's (Inline) or beside every paragraph (Side by side), with the
change's pair in the right margin. Its controls take the formatting toolbar's place in the
toolbar row (`ReviewBar`, from `features/draft-review`, through `DocumentToolbarPortal`,
`document-state-slot.tsx`), unscrolled
since the bar fits itself. While a room opens, the editor area shows `DelayedContentSkeleton`
after 500 ms, never a blank or an empty page. Commands and their Undo belong to
[`draft-review`](../../draft-review/.context/draft-review.md).

`PaintHold` retains finished paint across lifecycle handoffs. Same-entry URL replacements
disable router scroll restoration so editor anchor navigation owns scrolling. Side/Work rows and their notice paint before
the atomic write-back; editor marks remain derived from actual text.

## Schema and repair

A schema fence changes the mounted editor to read-only through its options seam;
it does not rebuild the editor or undo manager. A schema-stale reset unmounts
it and shows the unavailable state.

Binding waits behind the bounded bind horizon (`editor-bind-horizon.ts`, 5 s), then
always mounts; when the evidence timed out, `evidenceDegraded` hides the word count.
There is no repair notice: a schema verdict is a fence, never a report of removed
text.

`SchemaNotices.tsx` renders the fence as one error bar in
`EditorSurfaceFrame`'s `notices` slot, prose-aligned above the toolbar: "Editing paused"
and Refresh, which reloads the page. The same refusal also makes the app reload by
itself once the writer pauses (`client/release`). The slot collapses (`empty:hidden`)
when there is no fence.

## Related contracts

- [`surfaces/formatting/.context/CONTEXT.md`](../surfaces/formatting/.context/CONTEXT.md)
- [`surfaces/link/.context/CONTEXT.md`](../surfaces/link/.context/CONTEXT.md)
- [`surfaces/blocks/.context/CONTEXT.md`](../surfaces/blocks/.context/CONTEXT.md)
- [`surfaces/table/.context/CONTEXT.md`](../surfaces/table/.context/CONTEXT.md)
- [`surfaces/objects/.context/CONTEXT.md`](../surfaces/objects/.context/CONTEXT.md)
- [`chrome/.context/CONTEXT.md`](../chrome/.context/CONTEXT.md)
