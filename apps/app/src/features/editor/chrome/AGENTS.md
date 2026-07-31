# features/editor/chrome — chrome primitives

What every surface lane renders from: the object row, the themed Radix
wrappers, the mount host, and React's view of the kernel. Policy is headless
and lives in [`core/editor/chrome/`](../../../core/editor/chrome/AGENTS.md).

## Mental model

Five primitives and one host.

- **`OverlayIconRow`** — an object's verbs, overlaid just inside its top-right
  bounds (ruling 8; mockup 03b is the decision record). The corner itself is
  `object-overlay.ts` + `.meridian-object-overlay`, worn by every object
  overlay (the code fence's chip cluster too) so a new one never re-hand-rolls
  the inset, the fade, or the choice of coordinate space.
- **`EditorMenu` / `EditorPopover` / `EditorDialog`** — Radix, subordinated.
  Each registers as a layer in the Esc chain, defers Escape when something
  deeper is open, and hands the caret back to the prose on every close path.
- **`EditorMenuItem` / `EditorMenuCheckboxItem`** — the row, and the one place
  a refusal is drawn. A lane passes `blockedReason` and gets the greying, the
  swallowed select, and the reason on hover or focus; `ReasonTooltip` is the
  shape that reason wears everywhere, the toolbar's controls included.
- **`manuscript-overlay.ts`** — the pane measured chrome is drawn in, an
  element's box in that pane's coordinates, and which part of the pane the
  writer can see. Three functions, and the last is about a surface's TARGET
  rather than its placement: the pane's own clip does the placing.
- **`EditorNoticePill`** — what a surface says for a moment and takes back:
  a verb that reached the clipboard, an export the browser refused, a picture
  it would not take. Two tones and nothing else, so a lane brings the message
  and decides where it hangs; the object corner, the scroll pane, and a dialog
  all wear the same pill.
- **`SuggestionMenu`** — the list a writer types underneath, for `/` and for
  `[[`. It owns the eight-row cap, the internal scroll that follows the arrow
  keys, the fades on the list's own edges, and the announcement the caret's own
  element has to carry; a lane brings rows.
- **`EditorChromeHost`** — the one place chrome mounts, with nothing rendering
  editor chrome beside it. Surfaces arrive through `EDITOR_CHROME_SURFACES`;
  `EditorView.tsx` never learns about one. What a lane needs about the app rather
  than the document — the project, the active Work — it reads from
  `features/editor/editor-scope.tsx`, which is how the seam widens without a
  second mount and without a prop list on the host.

`shortcut-label.ts` sits beside them: `shortcutLabel("Mod+K")` is how every
lane prints a shortcut, because Mod is Cmd on macOS and a lane that tests the
platform itself will spell it a fourth way.

Radix is not wrapped away. It keeps owning dismissal, outside-click, and
roving focus (decision 2026-07-29). What these add is subordination.

**Attached by default, measured by exception.** Chrome that decorates
something with a node view of its own is RENDERED IN that element and placed
by CSS: scroll and reflow then move chrome and object as one piece, and there
is no rect to go stale. Only chrome with nowhere to live does the measuring —
an element ProseMirror renders itself and reads back as document content (a
table), controls that protrude past the frame they belong to, a menu
deliberately hung off a pointer point. `object-overlay.ts` holds that choice
for the object corner; every surviving measured surface rides
`watchManuscriptLayout` for its rect and the kernel's hover anchors for its
target.

**And every measured surface is measured into the manuscript's own scroll
pane** (`manuscript-overlay.ts`), never the viewport. It portals into the pane
and is `position: absolute` there, so the pane carries it through a scroll with
no measurement at all and clips it at its own edge. That is the whole of "a
grip is a label on its row, not a thing that travels to it" and of "no chrome
is ever painted outside the editor".

## Key rules

- **`onCloseAutoFocus` → `useChromeLayer(...).onCloseAutoFocus`.** Radix
  restores focus to the trigger, which is right for a page and wrong for a
  manuscript: the writer never left the sentence, so the next Space must be a
  space. The handler is layer-aware, and that part is load-bearing: a menu item
  that opens a form leaves the form behind, and handing the caret back then
  pulls focus out of a surface on the frame it appeared — which Radix reads as
  an outside interaction and dismisses. A close returns the caret only when it
  was the last thing on screen.
- **A lane that returns focus somewhere else passes `returnFocus`**, and never
  its own timer. The guards above are the reason: a lane racing Radix's teardown
  from a `requestAnimationFrame` loses, and worse, it hands focus back over the
  surface that just replaced it. `returnFocus` runs in the layer's place, under
  the same two guards. The peer-mark popover is the case that earns it — its door
  is a focusable span inside the prose, so a writer who arrived by Tab continues
  from the mark rather than from the caret.
- **`onEscapeKeyDown` → `useChromeLayer(...).onEscapeKeyDown`.** Without it a
  single Esc closes a dialog and the pane inside it, spending two steps of the
  walk home on one key.
- **A surface's own shortcuts go in `useChromeLayer({ keys })`,** never in a
  `document` listener. Focus is inside portalled content while a dialog is open,
  where ProseMirror hears nothing, so the kernel's document route is what serves
  the chord — and going through the layer is what puts the binding in the
  kernel's bindings, under its scope ladder, and in front of the validation that
  catches a second claimant. `keys` belongs to the layer, not to the content
  inside it: a dialog's Ctrl+Enter has to be able to open a pane that is closed.
  The hook registers them against the layer's own identity, which is what makes
  a chord the dialog and its pane both claim go to the pane.
- **Wrap what a surface renders in `layer.scope(...)`.** That is how a layer
  opened inside another knows its parent, and depth is what orders the walk —
  React mounts child effects first, so arrival order says the opposite. A
  surface that skips it makes every layer inside it a sibling.
- **A Radix-backed layer declares `dismissal: "self"`; anything hand-rolled
  keeps the default.** The kernel's Escape backstop serves the default and
  stands aside for `"self"`, so declaring `"self"` without listening is how a
  writer gets stuck.
- **Chrome mounts for the active editor only** (`EditorChromeHost`'s `active`).
  The desktop context host keeps several editors warm behind the visible one,
  and the Radix surfaces a lane opens still portal to the body, where nothing
  about the hidden editor reaches them.
- **A popover ignores focus alone as a dismissal.** Focus is always in motion
  around an editor form, and Radix would read every move as a reason to close
  one. Escape and a pointer outside still dismiss it, which is what a writer
  means.
- **`modal={false}`** on menus and popovers. A modal surface freezes the page
  behind it, and the page behind it is the writer's chapter: clicking away must
  land the caret where the writer clicked, not merely dismiss.
- **A measured surface is `position: absolute` in the manuscript's pane, never
  `fixed` in the viewport.** Viewport coordinates are wrong the instant the pane
  scrolls, so they can only be corrected a frame later — measured at one wheel
  notch a frame, that put the table's row grip beside a row three below the
  pointer's and painted the block handle over the app's breadcrumb, opaque, off
  the top of the editor. In the pane's coordinates a scroll changes nothing, and
  the pane's overflow clips what has left it on the frame it leaves. A pointer
  reading and a Radix anchor point stay in the viewport's space; nothing else
  does.
- **A measured anchor follows `watchManuscriptLayout`, and nothing else.** An
  element keeps its identity and its size while travelling: Alt+Arrow moves its
  block, a peer types above it, a diagram above it finishes rendering. A surface
  watching any shorter list paints over whatever slid into its old corner — and
  an overlay is opaque and takes clicks, so a stale one eats the click the
  writer aimed at the prose. `useAnchorRect` is the hook, and it answers in
  overlay coordinates; the watcher itself is the kernel's, shared with the
  approach's re-hit-testing so geometry and target cannot fall out of step.
- **Geometry following is not target following.** A rect that keeps up says
  nothing about whether the pointer is still on the thing it decorates. Which
  target is hovered is one kernel answer for the whole editor
  (`core/editor/chrome/hover-anchor.ts`); a lane that keeps its own will
  disagree with the others the first time the writer scrolls.
- **Elements are geometry, holds are identity.** What a surface aims at between
  frames is a `NodeHold` (`core/editor/anchors.ts`), through `useNodeHold`: it
  carries the hold across every transaction and answers null once the node is
  gone, and null is a surface's dismissal. An element answers only "where is
  this drawn, right now" — a node view is replaced by rebuilds the document
  never asked for, and a keyed decoration widget is rebuilt when its own label
  changes. Reading an element per frame is correct; remembering one is not.
- **Anchoring is not re-implemented per lane.** `EditorMenu` at a point hangs
  off `pointer-anchor.ts`; its position is inline style, because a utility class
  that failed to reach it would silently drop every claimed menu in the top-left
  corner. `EditorPopover` measures a virtual reference instead and takes either
  a fixed point (`at`) or a rect that moves with the text (`anchorRect`).
- **An anchor that cannot be measured is no anchor, and no surface.** Null is a
  real answer — a trigger's decoration leaves the DOM the moment its text does —
  and `EditorPopover` then does not mount, the same answer `useAnchorRect` gives
  measured chrome. A zero rect would have been a live menu in the corner of the
  viewport. Once placed it keeps its last rect for a frame that cannot measure,
  so a peer's whole-document rebuild does not take an open menu away; and the
  chrome LAYER still registers on the lane's own `open`, because whether a
  surface can be drawn and whether it is open are different questions and
  Escape must have an owner either way.
- **A menu keyed on a pointer point remounts when the point moves.** Radix
  positions through floating-ui's `autoUpdate`, which never sees a fixed anchor
  move, so `EditorMenu` carries the key. A virtual reference is re-measured
  instead, which is why the popover does not need one.
- **A surface the writer is still typing under keeps focus in the prose**
  (`focusOnOpen="prose"`). Nothing inside it may be focusable, and its rows
  cancel their own mousedown.
- **Chrome that portals out of the prose spreads
  `editorChromeAttributes(chrome)`**, or right-clicks on it bypass the claim
  ladder — measured chrome included, which lands in the pane rather than the
  body but is still outside `view.dom` where every hit test looks. The mark names the editor, because two documents open side by side
  are two kernels listening on one page.
- **A scroll-edge fade is a mask on the element that scrolls** (ruling
  2026-07-30). Drawn on the surface around it, the band sits at that surface's
  border instead of the list's and cannot tell a pinned header from content —
  the slash menu's veiled the table-cell notice and said "more above" about a
  header that never moves. A mask also spares the fade from having to imitate
  the surface colour. `chat-scroll-fade-bottom` (globals.css) is the same
  mechanism on the transcript.

- **A greyed row shows its LABEL alone** (law 5, ruling 2026-07-29). Grey must
  still say why, on demand rather than permanently: a reason printed under
  every refused row is standing information, and three of them turn a menu into
  a paragraph. Rows wear `aria-disabled`, never Radix's `disabled`, which takes
  the hover and focus path away and the tooltip with it. One shared note above
  a whole list — the slash menu's — is a different thing and stays.
- No raw color. Chip and row styling lives in the stylesheet beside the
  component that renders it; token classes elsewhere.

- **`index.ts` carries primitives, never the surface list or the host.** Both
  name every lane, so a barrel that re-exported either would make importing one
  primitive import every surface in the editor — and a lane's own tests would
  load every other lane's dependencies. `EditorView` imports the host from its
  own module.

## Anti-patterns

- Any `position: fixed` in editor chrome, or a portal to `document.body` for
  something anchored to the manuscript. Both are the viewport again, and the
  viewport is what let a grip fly over the app's breadcrumb.
- A lane rendering its own Radix root, its own anchor, or its own focus return.
- A lane adding a component to `EditorView.tsx` instead of a row to
  `chrome-surfaces.tsx`. That includes a surface that needs the project: the
  scope provider exists so the answer is a read, not a second mount.
- Local `useState` mirroring anything the kernel or the editor already stores —
  the resolved context, suppression, a transaction counter. Every signal here is
  a store read through `useSyncExternalStore`, which is also what keeps a change
  that lands between render and subscription from going missing.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../../core/editor/chrome/.context/CONTEXT.md`](../../../core/editor/chrome/.context/CONTEXT.md)
  for the seams and the Esc chain
→ [`../surfaces/toolbar/AGENTS.md`](../surfaces/toolbar/AGENTS.md)
