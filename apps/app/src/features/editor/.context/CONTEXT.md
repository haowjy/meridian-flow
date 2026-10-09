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

The rest of this surface is the prose column, the sync indicator, and the
notice/popover surfaces below. Image ingress is not here: it is a lane of its
own ([`surfaces/images/AGENTS.md`](../surfaces/images/AGENTS.md)) whose runtime
`EditorView` mounts, exactly as it mounts the link runtime.

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

**Scroll past end**: `editorProseScrollPastEnd` reserves half a viewport of
padding under the last block, so a manuscript keeps scrolling until its final
line sits in the upper half of the pane and a writer never types against the
bottom edge. The reserve is on the ProseMirror node rather than a wrapper, so a
press in it is ProseMirror's to answer: the caret lands at the end of the
document, and after an object it lands as a gapcursor rather than selecting the
object. Chrome that measures the manuscript checks a block's own box
(`surfaces/blocks/block-geometry.ts`), because the prose node keeps answering
`posAtCoords` far below the last line and a handle beside blank page belongs to
nothing.

The reserve only works because the prose node also carries `shrink-0`. It is a
flex item in the fill chain, and `min-h-full` replaces the automatic minimum
size that would otherwise hold a flex item at its content height; without
`shrink-0` the flex algorithm squashes the box back to the scroll viewport, and
the padding is drawn behind the blocks instead of below them. The failure is
quiet — the manuscript still scrolls, it just stops dead at its last block — so
verify past-the-end scrolling in a browser after touching this chain.

Prose canvases carry no `focus-ring`: the caret is the focus indicator, and
the control-style ring always fires on autofocused surfaces.

## The typed-under menus

Two triggers publish an open menu the writer keeps typing underneath: `/` for
blocks (`surfaces/slash/`) and `[[` for documents (`surfaces/link/`). They share
one surface, `chrome/SuggestionMenu`, one editor-side mechanism,
`core/editor/extensions/suggestion/`, and one headless store,
`core/completion/` — each lane brings rows and reacts to a choice, and nothing
else. The store is where the chat composer's own `@` menu will read from, so a
surface change that assumes ProseMirror geometry belongs in the surface, not the
store. What matters from outside them: focus stays in the
prose while a menu is open (`focusOnOpen="prose"`), and the anchor is something
that moves, so they read `anchorRect` rather than a captured point. Both are
`EditorPopover` capabilities, and the link lane's other surfaces inherit them.

## Draft chrome

Two self-contained surfaces, both resolving their own state from
`DraftReviewProvider` (never props-drilled):

- `DraftReviewChip` — the version chip on a live document with a pending
  draft, mounted by the context feature's `DocumentIdentityBar` in the
  breadcrumb row. It is the same `DraftSwitcher` menu as in review, showing
  Live; its Draft item opens the review.
- `DraftReviewBand` — the review controls inside `DocumentIdentityBar`, in the
  same row as the path (there is no separate header above it), once
  `inlineReview.shown`: the version chip (Draft), the document's change-list
  button (an icon, in every review state, opening a popover with
  `DocumentChanges` and "All changes in <Work>"), the stepper, Show changes,
  Discard draft and Apply draft. The row takes the dock tint while a draft is
  reviewed. As the row narrows it collapses in a fixed order (folders, Show
  changes label, stepper count, file name, button labels); the chip, the list
  icon, Discard and Apply stay. A line under the row appears only for a failed whole-draft
  command, "No changes left" with Next draft, or "Formatting changes remain".
  Its parts live in `features/draft-review`.
- The focused change's bar is the `review-change-bar` chrome surface
  (`surfaces/review`). It never covers manuscript text. With room in the right
  margin (`place-review-bar`: at least 132px between the text column and the
  pane edge, 200px when the bar carries "Discard with your edits") it is portalled into the manuscript's scroll pane beside the
  change's first line. Without, the surface asks the inline-review plugin for a
  bar slot (`setInlineReviewBarSlot`): an empty non-editable block widget after
  the paragraph the change ends in, which the bar is portalled into, so the
  text below moves down for it. Both scroll with the text. `useInlineReviewFocus` keeps the marks and the controller saying the
  same thing (Show changes, the focused change, a click on a mark, the pulse on
  arrivals).

The chip and header are mutually exclusive by the chip's own inline-review
check, not by a shared slot. Both read the same `shown` flag, so the swap
happens in one frame.

**Entry hold.** Entering review holds the plain live view, header included,
until the review editor exists AND its change marks have arrived, then switches
everything in one frame. `EditorView` reports `chromeShown` to the controller
in a layout effect (`setInlineReviewShown`); the live wrapper hides, the review
wrapper shows and the header mounts in the same paint. If the marks never
arrive the review shows anyway after 1.5 s (`REVIEW_MARKS_WAIT_MS`). A
draft-only tab has no live view to hold and reports shown at once. Wrappers
carry `data-editor-surface="live|review"` for frame probes. A move between two
drafts' reviews is held the same way by `features/project/dock/review-handover`
(see `features/draft-review/AGENTS.md`).

The review manuscript is the server draft projection plus decorations, in the
manner of suggestion mode. Insertions are inline decorations over text that
exists in the projection (green AI, gold writer, gold inside green for a writer
edit inside an AI change, dashed grey when the server flags `mergeArtifact`: a
true CRDT interleave, not merely two authors in one hunk).
Removed live text is a read-only widget decoration (`removal-widget.ts`), struck
through where it was: crimson for the AI, gold for the writer, each stretch in its
remover's colour (a text hunk's `deletedSpans`; a block hunk's removal is read
from its owning operations), never part of the
Y.Doc or the TipTap document, so it cannot be typed into, selected into or
saved. A removal the server could not attribute is struck in no author's
colour. Long removals (over 200 removed characters) fold to "N paragraphs
removed" (between blocks) or "N words removed" (inside a paragraph) and open on
click. A pointer click on the struck text puts the caret at the removal's
position (for a removed block, before or after it by the clicked half); the
removal itself stays untouched. Focus emphasizes every operation sharing the
change's `closureClassId`. The review editor stays editable on desktop: the
draft is a Yjs room and the writer is one more peer in it, so keystrokes in
review land in the draft branch rather than live. The phone mounts it
read-only (`features/project/mobile`).
`setInlineReviewMarksVisible(false)` hides every mark and removal without
remounting; the model, selection and open folds survive.

## Component API

### Command modules the surfaces consume

`block-alignment.ts`, `core/editor/links/link-commands.ts`, and
`core/editor/table-operations.ts` are the command and resolution layer the
surfaces consume. The toolbar uses the first two; the table surfaces use the
third.

`linkAttributesAtSelection` exists because `editor.isActive("link")` can miss an
empty selection at a mark boundary, notably the link's start. It uses
`getMarkRange` for carets so a link control stays available at either edge. Any
control that opens on a mark-touching caret should resolve the same way rather
than gating on `isActive` alone.

### Insertion and document catalogs

`EditorView` owns §5.7's eleven-entry slash catalog and the `[[` menu's
document list, and hands `useMountedEditor` a *getter* for each, never the
catalog itself. The extension mounts as a construction fact;
its localized labels, group headings, hints, and the door into the image picker
are read when the menu opens, so a locale switch relabels the menu instead of
appearing in `EditorMountIdentity` and remounting the editor. The getter returns
null on a code surface, on a read-only host, and behind a schema fence — the
last because a slash command dispatches through a chain, and chains run on a
non-editable editor. The wikilink getter answers null on the same three, plus a
host with no project: without one there is nothing to search and nothing a link
could resolve against. Its documents are `useLinkableDocuments`' index, which
is the resolver's own candidate set
([`features/links`](../../links/.context/CONTEXT.md)).

## The editor's scope

One plain value, `{ projectId, workId }`, provided by `EditorView` around
its host (`editor-scope.tsx`) and read with `useEditorScope()`. The Editor has
no Work: for links, Scratch and Uploads holders use the replica's projected
resource location `workId` (including No Work); manuscript, kb, user, and
unfiled holders use the project's No Work row. Until the location or No Work
row is known, the scope is unresolved. Neither `?work`, remembered Work, nor
`baseUri` supplies a fallback.

This same value drives the local link index, `@` and LinkForm catalogs,
resolution/cache registration, contextual Create, and link destinations.
Scope is deliberately NOT part of `EditorMountIdentity`: moving a holder
must not destroy its collaborative editor or UndoManager. Route `workId`
and `reviewWorkId` remain separate inputs for draft navigation and review.

The runtimes `EditorView` mounts (`ProjectLinkRuntime`, `ImageIngressRuntime`)
are ports and render nothing; the surfaces those lanes show the writer mount
through the chrome host like every other one. See
[`surfaces/link/.context/CONTEXT.md`](../surfaces/link/.context/CONTEXT.md).

`EditorSurfaceFrame` accepts scrolling content and the tracked editor's optional
scroll class/ref/handler. The frame owns every shared vertical, scroll, and
prose-trim rule; hosts own their content and horizontal coordinate strategy.

The frame's scroller is also the manuscript overlay: `position: relative` plus
an overflow clip, which makes it the containing block for every measured
surface and the box that takes one off the page when it leaves
([`chrome/manuscript-overlay.ts`](../chrome/manuscript-overlay.ts)). That clip
turns the column's gutter into a hard constraint rather than a look —
`editor-column.ts` states the floor.

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

The lane is [`surfaces/peer-marks/`](../surfaces/peer-marks/AGENTS.md): one
chrome surface over the press the projection's own plugin writes. `EditorView`
holds nothing about it — the click, the Enter, the caret the writer left, and the
mark that is open all live in `core/editor/extensions/` beside the decorations
they belong to, and the surface reads them.

Review needs no special case. A branch room has its own anchor space, so it
mounts no projection at all, and a surface with no projection to read stands
down on its own.

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

Popover focus follows activation. Pointer open leaves the caret in the prose and
pointer close restores the held selection. Keyboard activation moves focus into
the popover; Escape or close returns focus to the mark's current span. Neither
hands anything back when another surface opened in its place — Mod+K reaches the
popover as a close, and the caret then belongs to what opened.
