# surfaces/blocks — contracts

Reference depth for block movement. Read [`AGENTS.md`](../AGENTS.md) first.

## Seams and drops

`blockSeams(doc)` returns one position before every top-level block plus one
after the last, so a document with n blocks has n + 1 seams. Every seam
resolves at document depth by construction, which is the whole safety argument:
there is no seam inside a table, a figure, a fence, or a list item to drop into.

`moveBlockToSeamTransaction` refuses two seams — the ones on either side of the
block being moved. A writer who drops a paragraph back on its own edge asked
for nothing, and an undo entry for it would be a lie.

The seam is measured on the document BEFORE the lift, so a seam below the block
has to shift up by the block's size once it is removed. That single line is the
only arithmetic in the move.

## What travels with a block

| The writer was | After the move |
|---|---|
| a caret inside the block | the same offset inside it, wherever it landed |
| a text selection inside it | the same range |
| an object selection on it | still selected |
| a whole-table cell selection | still selected (a `NodeSelection` on a table normalizes back to one) |
| anywhere else | untouched |

Deleting the last block standing replaces it with an empty paragraph rather
than emptying the document: the schema needs a block and the writer needs
somewhere to type.

## The drag

The held block lives in the document, in
[`core/editor/blocks/`](../../../../../core/editor/blocks/index.ts), not in
React state. Two reasons, and the second is the one that bites: a peer's edit
or an AI write can land while the pointer is down (law 9 gates nothing), and
the block the writer grabbed has to be the block that lands. One hold beats one
per consumer.

It is a `NodeHold` taken with `holdBlock`, not a number. A peer's write arrives as a replacement of
the whole document (see
[the position contract](../../../../../core/editor/.context/CONTEXT.md)), so a
mapped number reports the grab deleted on every peer keystroke — which used to
cancel the drag mid-gesture, drop line and all. The hold answers with the Yjs
element behind the block instead, so "a peer deleted the block under my pointer"
is the element changing, and the empty paragraph the schema puts in its place
cannot pass for the block that was grabbed.

**The drop target is never stored.** A child index is stale the moment a peer
inserts a block above: the jade line would go on naming a seam the drop no
longer lands on. The gesture keeps the pointer's y instead, re-derives the seam
on every transaction, and reads it once more at the drop. The pointer is the
writer's intent, the rendered geometry under it is the truth, and a seam is
only ever a reading of the two — which is also why the line stays under the
pointer when the document shifts, rather than chasing content that moved.

### Two doors into it

The margin handle is one drag source and a block object's body is the other,
and they are the same gesture: `block-gesture.ts` takes the press whichever door
it came through, so both hold one block, take one kernel drag token, and end in
one finalizer. The handle's press arrives as `pressHandle` because the handle is
chrome this lane renders; the body's own listener lives inside the controller,
on the prose. Which objects offer their body is `EDITOR_OBJECT_TYPES`'s `body`
column, read through `objectBody` — `block-drag` for a figure, a rule and a
rendered diagram, `text` for a table, whose cells take a caret and own the
pointer that sweeps across them.

`inline-drag` is the third value and it belongs to nothing here: a picture
travels by ProseMirror's own drag, which lands it wherever a caret can go and
draws the dropcursor there (human ruling, 2026-07-29). This surface asks for
`block-drag` by name, so it declines an inline object's press and refuses none
of the browser's answers, and the block gesture and the inline one never
overlap. The picture's paragraph still has a margin handle, which is where
"move this whole line to a seam" lives.

Three differences between the doors, each forced:

| | Handle | Object body |
|---|---|---|
| the press | prevented, so the caret stays where the writer left it | not prevented, or law 1's click never reaches ProseMirror and the object stops selecting |
| pointer capture | taken, so a touch drag is not a page scroll | none: capture retargets the mouse events ProseMirror reads to decide a click |
| a press that never travels | opens the menu | left alone, and ProseMirror turns it into the jade ring |

The body door is mouse-only. A finger has no cursor to aim with and a drag
under it is the page scrolling; touch reaches the same move through the handle
it taps.

Two answers the browser would give instead are refused. Its own HTML5 drag,
wherever it would carry a BLOCK object off — ProseMirror arms it on mousedown,
it draws no block drop line, and it moves a node by serializing and re-parsing
it, which brought a figure back as a bare paragraph. And a text selection
growing out of the object, for as long as a body gesture owns the pointer. Prose that merely
runs THROUGH an object is untouched: that selection starts somewhere else, so
no gesture begins.

What the pointer landed on decides, not only what the registry says. Text
ProseMirror owns is never a drag source — a mermaid fence is a diagram when it
renders and its own source when the caret is in it, and the DOM answers what
one registration cannot, because everything standing in for that text is
`contenteditable="false"`. Controls an object embeds (a figure's alt and
caption fields) belong to the control.

A press becomes a drag only after 4px of travel — the same slop the kernel uses
for a sweep. Before that it is still a click, and telling the kernel otherwise
would blank every surface on the page for the length of a menu press.

### Ending it

One finalizer, seven doors: release (the only one that commits), browser
cancel, lost capture, window blur, Escape, unmount, and the document letting go
of the held block. Five of the seven are interruptions the writer never asked
for, and any of them skipping the finalizer leaves `chrome.suppressed` true
with nothing left to clear it — every surface on the page frozen until reload.
The kernel's closer is token-guarded, so calling it late or twice is safe.

Escape belongs to the kernel's chain whenever the editor can hear it: the chain
cancels through the handler `beginDrag` was given, which lands in the finalizer,
and law 3 gets its one key and one step. The window listener covers only the
case the chain cannot see — a press that began on portalled chrome may have
left focus outside the prose — and it stops the event there, because a key that
cancels a drag AND walks the caret off an object has taken two steps.

The grip stays mounted for the whole gesture, invisible once lifted. It holds
the pointer capture that keeps a touch drag from turning into a page scroll,
and capture dies with the element: letting the hover reveal unmount it ended
every drag on its own first frame.

## Geometry

| Piece | Anchored to |
|---|---|
| handle x | the prose column's left text edge, less `HANDLE_CLEARANCE` and its own width |
| handle y | the block's first LINE (its padding plus half the leading), not its box |
| drop line | the prose column's edges, at the midpoint between two blocks |

### Measured on a frame, into the pane

Both readings are `getBoundingClientRect` and `getComputedStyle` against a DOM
ProseMirror has only just rewritten, and this surface re-renders on every
transaction — the writer's keystrokes, a peer typing, an AI write landing.
Measuring them in render forced a synchronous layout on each one.
`useBlockChromePlacement` schedules a frame instead and moves state only when
the numbers moved, so a transaction that changed nothing on screen costs one
measurement and no render. The pointer's own moves are measured at once: the
drop line belongs under the pointer on the frame the writer moved it.

The handle and the line are drawn IN the manuscript's scroll pane and placed in
its coordinates (`features/editor/chrome/manuscript-overlay.ts`), which is what
takes scroll off the list of things a measurement has to keep up with. Placed
against the viewport, the handle was a frame behind every scroll and had
nothing clipping it: probed at one wheel notch a frame, it painted at viewport
top 8 and then -329 with `data-state="open"` — fully opaque, over the app's
breadcrumb and then off the top of the window. In the pane its number does not
change on a scroll at all, and the pane's overflow takes it off the page when
its block goes.

Two readings stay in the viewport's space, because a pointer event speaks no
other language and Radix positions in it: `blockUnderPointer`'s column edges
(`proseColumnEdgesInViewport`) and `handleAnchorPoint`, which reads the block
menu's anchor off the handle element rather than off its placement. Both are
one-directional crossings — nothing read from the writer becomes a placement,
and no placement is ever compared against a pointer.

### The left margin is shared

The margin holds two controls, and they used to overlap by 10px: whichever
painted on top took the right-click for both. The band is split by ruling, and
the numbers below are standard geometry (prose edge 288, text edge and table
frame 328, so a 40px band):

| Band | Owner | x |
|---|---|---|
| outer | block handle | 284 to **306** |
| inner | table row grips | **307** to 322 |

A grip belongs beside the row it serves; the handle is a document-level
control, so it takes the outer band. Both are measured from the text edge
rather than from the pane, so the split holds at every column width: the grip
starts 21px inside the frame (`ROW_GRIP_GAP` + its own width) and
`HANDLE_CLEARANCE` is 22, one pixel clear. M6's
[`table/.context/CONTEXT.md`](../../table/.context/CONTEXT.md) states the same
split from the other side; change one and the other is wrong.

The handle may move FURTHER from the text (a wider clearance is always legal)
and never closer, because closer is back into the grip band. It cost the
12px-clear-of-text reading from mockup 08, which is the trade the ruling makes.

`proseColumnEdges` is horizontal only, deliberately. The prose node reserves
half a viewport of padding under the last line so a writer can keep typing
mid-screen, so its box says nothing about where the manuscript ends. Hover is
judged against each block's own box instead, with 8px of slack so a pointer
crossing the gap between two paragraphs does not blink the handle off.

## Approach, on a pointer and on a finger

This lane owns one question, registered as a `HoverAnchorLane`: which
top-level block is at this point. The pointer spends the whole approach in the
margin, where `posAtCoords` has nothing useful to say, so x is pulled into the
column before asking, and the answer is checked against the block's own box.

Everything else is the kernel's (`core/editor/chrome/hover-anchor.ts`): the
delay and the grace, the pointer's last place, the re-hit-test when the pane
scrolls under a still hand, the rule that travelling onto the handle — which
portals out of the scroller and reads to the DOM as leaving the editor — is
not leaving the block, and the rule that this handle and an object's own
controls are on ONE block or the handle is not on screen.

A finger never hovers, so the touch path is a different door onto the same
handle: `chrome.coarsePointer` decides which one is live, and on coarse input
the anchor follows the selection — the writer's own tap is the approach. Last
pointer type rather than a media query, because a laptop with a touchscreen
should answer for the hand actually on it. There is no fade-out on that path
either: the handle belongs to the selected block until another is chosen.

## Why the handle is still measured

Every object's controls are rendered inside the object's own node view, where
scroll and reflow cannot strand them. The handle cannot be, for two reasons
that are both about what a top-level block IS:

- **Most of them are ProseMirror's own DOM.** A paragraph, a heading, a list,
  a table wrapper: ProseMirror reads those elements back as document content,
  so a child inserted into one is a change it will try to parse. Only the
  object node views are safe to render into, and the handle serves every block.
- **The handle is in the margin, not in the block.** It hangs off the prose
  COLUMN's left text edge — shared with the table's row grips, split to the
  pixel — while a block's own box starts at that edge. Positioning it against
  the block would re-derive the column from whichever block happened to be
  hovered, and a centred table is narrower than the paragraph above it.

So it stays a measured portal, on `watchManuscriptLayout` for its rect and on
the kernel's hover anchors for its target. Both invariants are covered; only
the mechanism differs.

## The block menu

Two doors, one call. A left-click on the grip and a right-click on it both land
in `openBlockMenuAt`, so the menu is in one place, about one block, whichever
way the writer asked. The right-click goes through the kernel's claim ladder at
the `grip` rung, matched by the `data-block-handle` marker — the table's grips
carry their own and the two never both match. Declining is a real answer there:
a right-click during a drag is not a menu request, and one with no handle under
it belongs to the browser.

The claim reads the target from render rather than remembering it per element,
which an object's row has to do. There is only ever one block handle, and it
exists only once the approach has settled on a block, so there is nothing to
disambiguate.


Opening it stands the writer on the block: a caret in prose, a node selection
on an object (law 1, a click reads). That is not decoration — it is what lets
the menu ask the toolbar's own `blockTypeStates` about a block the writer
merely pointed at, so both surfaces refuse the same targets for the same
reasons.

Turn into is present only on text blocks (§5.8). The consequences are worth
naming: a list, a quote, or a table has no Turn into row, so the block menu
converts a paragraph INTO a list but never back. Un-listing lives on the
toolbar, whose control is lit when the caret is inside the list, and later on
the formatting menu. Alignment for text blocks is §5.1's line about the block
menu and is NOT here: ruling 15 put alignment on the persistent toolbar, and
one verb in two places is how the two documents disagree.
