# features/editor — contracts and architecture

This reference covers the app-facing editor boundary: session binding, review
projection, scope, shared geometry. Read [`AGENTS.md`](../AGENTS.md)
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

Word count reads the selection’s content, not its first `from..to` range: a cell rectangle
has several ranges. Selected counts update when content changes even if the selection stays equal.

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

Drafts are off while the editor moves to Loro: the editor paints Live only, and a review shows
its changes in the review lists, not as paint in the manuscript. Drafts come back as Loro forks
in phase 1e. Projection, commands and history belong to the
[draft-review runtime](../../draft-review/.context/draft-review.md).

Each document host (main, the side, the phone) has its own review
(`features/project/DocumentReview.tsx`); its chrome and change bars read that
review's projection, and `EditorView` does not own a second review controller.
The version chip (`DocumentVersionMenu`, Live with every draft one pick away) sits at the
toolbar row's end on desktop and phone alike, and gives way to the review's own chip once a
review of the document is entered. The chip names what the host paints: once a Discard or
Apply ends the draft, the review stays open ("No changes left", its Undo) but the chip reads
Live, as the text does. On desktop the review's controls live in the identity
bar (`DraftReviewBand`), with no separate header above it. The focused
change's bar (`surfaces/review`) never covers manuscript text: it sits in the
right margin beside the change when there is room, else in a block slot after
the change's last paragraph. Commands and Discard history belong to
[`draft-review`](../../draft-review/.context/draft-review.md).

`PaintHold` retains finished paint across lifecycle handoffs. Apply and Discard
resolve the Work's marks in the same Live Y.Doc, without replacing the editor,
selection or undo manager.

`useSuggestionReviewFocus` registers the mounted editor as the review's, so the
review's focus commands reach it, and keeps its emphasized change the review's. Same-entry URL replacements
disable router scroll restoration so editor anchor navigation owns scrolling. Side/Work rows and their notice paint before
the atomic write-back; editor marks remain derived from actual text.

## Schema and repair

A schema fence changes the mounted editor to read-only through its options seam;
it does not rebuild the editor or undo manager. A schema-stale reset unmounts
it and shows the unavailable state.

Binding waits behind the bounded repair-evidence horizon, then always mounts
(even when evidence timed out). `SchemaRepairNotice` reports witnessed repairs
and never gates editing or offers reinsertion or approval. It reads session
repair snapshots rather than inspecting the editor document.

Both notices live in `SchemaNotices.tsx` as one-line bars in
`EditorSurfaceFrame`'s `notices` slot, prose-aligned above the toolbar; the slot
collapses when neither has anything to say. The fence bar carries Refresh; the same refusal also makes the app reload by itself once the writer pauses (`client/release`). The
repair bar says only that text was removed; its Details popover holds every
recovered excerpt with Copy, then the cause and Dismiss, so the excerpts never
push the manuscript down. The popover anchors to the whole bar and takes its
width, so it fits a narrow side pane. Dismiss hides the bar until the session
reports another repair and sends focus to the editor, or to Refresh while the
fence holds the editor read-only; one `SchemaNotices` owns both bars for that. Copy goes through `clipboard.ts`
and reports a refusal on that excerpt; a pending Copied reset never erases it.

## Related contracts

- [`surfaces/formatting/.context/CONTEXT.md`](../surfaces/formatting/.context/CONTEXT.md)
- [`surfaces/link/.context/CONTEXT.md`](../surfaces/link/.context/CONTEXT.md)
- [`surfaces/blocks/.context/CONTEXT.md`](../surfaces/blocks/.context/CONTEXT.md)
- [`surfaces/table/.context/CONTEXT.md`](../surfaces/table/.context/CONTEXT.md)
- [`surfaces/objects/.context/CONTEXT.md`](../surfaces/objects/.context/CONTEXT.md)
- [`chrome/.context/CONTEXT.md`](../chrome/.context/CONTEXT.md)
