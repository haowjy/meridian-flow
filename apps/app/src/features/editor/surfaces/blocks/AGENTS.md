# surfaces/blocks — block movement

The margin handle, the drag with its jade drop line, the block menu, and
Alt+↑/↓ (§5.8). One surface, because they are one verb with four doors: every
one of them ends in the same transaction.

## Mental model

**The movable unit is a top-level block** — a direct child of the document.
That choice is load-bearing rather than a simplification: a seam between two
top-level children can never land inside a table, a figure, a fence, or a list
item, so "never drop inside a protected node" is a property of the geometry
instead of a check somebody has to remember. The handle in the margin points at
the same unit, so what the writer aims at and what lands are one thing.

Layers, and nothing crosses:

- `block-targets.ts` — positions and transactions, pure over `EditorState`.
- `block-geometry.ts` — what the browser drew: the margin, the seam under the
  pointer, where the line goes.
- `block-gesture.ts` — the drag: both pointer doors, the slop that tells a
  press from a click, and the one finalizer. It decides nothing about the
  document and nothing about timing.
- `block-placement.ts` — where the handle and the drop line are drawn, on a
  frame.
- `block-keymap.ts` — Alt+↑/↓ and its place in the kernel's scope ladder.
- `BlockMovementSurface.tsx` — the approach, the hold the menu stands on, and
  the composition of the rest.

Each module past the first two changes for its own reason: geometry invalidation,
pointer lifecycle, key precedence, and what the writer sees are four different
questions, and they used to collide in one 700-line file.

The document's own memory of a drag lives in
[`core/editor/blocks/`](../../../../core/editor/blocks/index.ts): which block a
gesture is holding, and whether it has lifted.

## Key rules

- **A drag has two starting places and one gesture.** The margin handle is
  one; the body of an object the registry marks `body: "block-drag"` is the other,
  because a writer's first instinct is to grab the thing itself. Both go
  through one controller, so there is one hold, one kernel token, one finalizer
  — and one difference: a press that never travels opens the menu on the handle
  and is left to ProseMirror on a body, where it becomes the jade ring.
- **An object that lands inline is not this gesture.** A picture
  (`body: "inline-drag"`) travels by ProseMirror's own drag, which carries it as
  an inline slice and puts it between two words with the dropcursor showing where (human
  ruling, 2026-07-29). This surface never sees that press. The margin handle
  above its paragraph is still how the whole LINE moves to a block seam, and
  the two gestures answer two different questions.
- **The body door opens only where the object IS the block**
  (`objectIsWholeBlock`). The drag moves a top-level block, so a figure sharing
  a list item with a paragraph would carry the whole list nobody grabbed; there
  the press stays the text selection the pointer was already drawing. The test
  is structural, per occurrence — the same rule is grabbable in the manuscript
  and only decoration inside a quote that also holds prose.
- **A block object moves one way.** ProseMirror's own HTML5 drag is refused
  wherever it would carry one off, including out of a field the object embeds.
  It shows no block drop line and it moves a node by serializing and re-parsing
  it, which brought a figure back as a bare paragraph. Over an object that
  lands inline that same drag is the right one and is left alone.
- **Text ProseMirror owns is never a drag source.** A mermaid fence is a
  diagram when it renders and its own source when the caret is inside it, and
  the registration cannot say which — the DOM can, because everything standing
  in for that text is `contenteditable="false"`.
- **Nothing here keeps a timer, a pointer listener, or a suppression rule.**
  The approach is one `registerHoverAnchor` lane that answers which block is at
  a point; the kernel owns the timing, the pointer's last place, the re-hit-test
  after a scroll, and the rule that one block owns hover chrome at a time. A
  drag is declared with `chrome.beginDrag`. A local `setTimeout` would linger
  through a drag, and a local pointer listener would disagree with every other
  lane the first time the writer scrolled without moving their hand.
- **One finalizer ends the gesture, and every way it can end calls that one.**
  Release, browser cancel, lost capture, window blur, Escape, unmount, and a
  peer deleting the held block are seven doors into one function. A gesture
  that ends without it leaves the kernel suppressing every surface on the page.
  Escape is the kernel's door, not a listener here: a gesture is the deepest
  rung of the walk home, so the chain reaches it through the `onCancel` that
  `beginDrag` was given, wherever the writer's focus had got to.
- **Every block held across a transaction is a `NodeHold`, carried by
  `followBlock`** (`core/editor/anchors.ts`). Position alone cannot say whether
  the block is still there: a remote write replaces the whole document, so the
  mapping calls every position deleted, and a deleted block's seams resolve to
  where its replacement now starts. The hold carries the Yjs element behind the
  block for that, and it lets go the moment the element is not the same one —
  including a move, which really is a new block. Nothing here stores a child
  index across a transaction either: the drop seam is derived from the pointer,
  every time.
- **Chrome geometry is measured on a frame, never in render.** The handle and
  the drop line are `getBoundingClientRect` readings against a DOM ProseMirror
  has just rewritten, and this surface re-renders on every transaction;
  measuring in render forced a synchronous layout on each one.
  `useBlockChromePlacement` schedules the measurement and moves state only
  when the numbers did.
- **What counts as "the manuscript moved" is `watchManuscriptLayout`'s answer,
  not this lane's.** A local watcher here listened for transactions and window
  resizes only, so a scroll under a still hand left the handle at its old
  viewport top. Any second list of signals will be short of that one again.
- **The handle is measured onto the page, and it is the exception.** Object
  controls are rendered inside the object's own node view, where nothing can
  strand them; the handle cannot be, because a top-level block is usually
  ProseMirror's own DOM and because the handle belongs to the prose COLUMN's
  margin rather than to any one block's box (`.context/CONTEXT.md`). Never by
  inserting anything into the manuscript either way (law 7): a widget
  decoration between two blocks inherits the manuscript's block spacing and
  pushes the page down by its own height.
- **The manuscript's DOM is ProseMirror's.** Styling a block by setting an
  attribute on its element does not survive: the DOM observer treats it as
  corruption and re-renders the node without it. The lift is a decoration.
- **The grip claims its own right-click** (`grip` rung). The kernel's default
  IS the browser's menu, so a surface that registers nothing gets the native
  menu over its own control by saying nothing. Every door — click, right-click,
  and later the keyboard twin — ends in the same open call.
- **Touch has its own door.** A tap has no hover to settle, so on coarse input
  the handle belongs to the block the selection landed in. The grip takes
  pointer capture and carries `touch-action: none`, or the browser reads the
  drag as a page scroll.
- **Alt+↑/↓ declines inside a table.** The same keys move rows there and the
  table surface owns them (§4, deepest owner). A selected table still moves —
  it is an object, and the writer selected the whole thing.
- **Turn into borrows the toolbar's fence** (`blockTypeRefusal`,
  `codeBlockRefusal`, `blockTypeReasonMessage`). A figure that cannot become a
  heading must be unable to from every door, and one rule is how that stays
  true.
- **Two law-5 shapes.** A move with nowhere to go is absent; a conversion the
  schema refuses is present, greyed, and says why when the writer reaches it.
  Refused rows pass `blockedReason` and never Radix's `disabled`, which would
  take the hover and focus path away and the reason with it.
- **Reach the chrome primitives by module, not through `chrome/index.ts`.**
  That barrel also carries the surface registry this lane is listed in, so the
  round trip is a module cycle.

## Anti-patterns

- Resolving the movable block by walking to the deepest node under the pointer.
  Nested reordering is a different design (see `.context/FUTURE`).
- Ending a gesture anywhere but the finalizer, or storing a drop target rather
  than deriving it.
- Splitting the handle's gesture from the object body's. They are one press with
  two doors, and two controllers would be two state machines that must agree.
- Asking which node types can be dragged by their body, or which of them may
  land between two words. Both are the `body` column in `EDITOR_OBJECT_TYPES`
  (`"text" | "block-drag" | "inline-drag"`, one column on purpose); a node name
  here would drift from it the first time a lane ships an object.
- Teaching this drag inline drop targets. ProseMirror's own drag already has
  them, and the dropcursor already draws the caret; a second inline landing
  path would be two answers to one question.
- Preventing the press that starts a body drag. The click that never travels
  has to reach ProseMirror, or the object stops selecting.
- A second refusal rule for whole-block conversions.
- Mounting anything in `EditorView.tsx` or reading suppression into local state.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md)
→ [`../toolbar/AGENTS.md`](../toolbar/AGENTS.md) for the fence this reuses
→ design of record: `editor-toolbar-split/interaction-model.md` §5.8, §2 laws
  1, 4, 5, 6, 7
