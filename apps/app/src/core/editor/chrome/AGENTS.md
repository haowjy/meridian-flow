# core/editor/chrome — the chrome kernel

Headless policy for every control surface in the editor: which context owns
chrome, who takes a right-click, what one Esc does, and when surfaces stand
down. It renders nothing. React lives in
[`features/editor/chrome/`](../../../features/editor/chrome/AGENTS.md).

## Mental model

One store per editor (`EditorChrome`), created by `ChromeKernelExtension` and
reached with `getEditorChrome(editor)`. Surfaces **register** with it; they do
not ask it for permission to exist. Everything the kernel decides is decided by
a pure function beside the store, so the policy is testable as data and the
extension only reads the document and dispatches.

Five things live here, and nothing else should:

- **The Esc chain.** `escStep` is the whole walk-home policy (law 3). A surface
  registers a layer while it is open and the chain decides whose turn it is.
- **The claim table.** An ordered ladder of right-click claimants. Not
  claiming is the designed outcome, not a gap.
- **Deepest-context resolution.** One answer to "what owns chrome right now",
  read by the Esc chain, the router, and the toolbar's greying.
- **Suppression and hover intent.** Approach chrome's timing, and standing
  down during a drag or sweep.
- **The approach.** Which block is hovered, answered once for the whole editor
  (`hover-anchor.ts`), from a pointer the kernel remembers and re-reads
  whenever `manuscript-layout.ts` says the manuscript moved.

**Surface exclusivity is not here** (decision 2026-07-29). Radix already makes
menus, popovers, and dialogs mutually exclusive layers. Do not build a claim
or suppress arbiter beside it.

**Approach exclusivity IS here**, and it is a different question. A hovered
target is not a layer: nothing opens it and nothing closes it, so Radix has
nothing to say. One block owns hover chrome at a time, and the pieces sharing
that block compose on it (an image's controls and its paragraph's grip).

## Key rules

- **Every right-click in the editor opens an editor menu, and the context
  picks which one** (human ruling, 2026-07-29, superseding ruling 11). The
  ladder ends in a `caret` rung rather than in the browser, so a bare caret in
  prose, in a table cell, and in a code fence all reach verbs.
- **Shift+right-click is never claimed.** It is the documented way to the
  browser's own menu, where spellcheck suggestions, lookup, and OS services
  live and nowhere else. The check sits above the ladder in
  `resolveContextClaim`, so no rung can forget it.
- **The claim decision is synchronous.** `preventDefault` after the event
  returns does nothing. Opening the surface may be deferred a tick; deciding
  may not.
- **A lane never keeps its own answer to "what is under the pointer".** It
  registers a `HoverAnchorLane` and answers only the part it alone knows: which
  block is at this point, which object, which cell, which link. Timing, the
  pointer's last place, the re-hit-test after a scroll, the hold while the
  pointer rests on a revealed control, and the single owner are the kernel's.
  Four private answers is exactly what put two hover chromes on screen for two
  different blocks.
- **Scroll is a pointer move with no pointer event.** A hand that never moved
  is over something else the moment the pane scrolls, so the approach re-reads
  its remembered point on every `watchManuscriptLayout` signal. Chrome that
  only re-measures its rect is chrome for a target the writer has left.
- **Hover and persistence are different modes.** A selected table's ⋮ and a
  caret inside a fence keep their chrome with no pointer involved; that belongs
  to the lane and never to the approach.
- **Nothing binds Escape but the chain, and nothing listens for it either.**
  `assertKeymapContribution` throws on the binding; a surface that wants a step
  in the walk registers a layer, and a surface that wants to be interrupted
  passes `beginDrag` an `onCancel`. The chain runs from wherever the key was
  pressed, so a keydown listener beside it is a step the chain neither owns nor
  observes — which is what a block drag's own window listener was until it was
  deleted.
- **A suggestion contributes retreat, never Escape.** Its host lease registers
  `backtrack` plus root `dismiss` against the suggestion surface's stable owner
  ID. The chain offers that action only when the matching layer is topmost; a
  deeper overlay and an active gesture still win. Before React has registered
  the layer, the newest retreat is the pending owner so the first Escape cannot
  outrun the menu. The same operation serves prose, the document backstop, and
  Radix's `onEscapeKeyDown`; there is no suggestion key binding or listener.
- **A key pressed outside the prose still goes through the registry.** A
  portalled layer holds focus while it is open and ProseMirror hears none of its
  keys, so a `layer`-scoped contribution may declare `reach: "chrome"` and the
  kernel's document route runs it. No surface adds a keydown listener of its own:
  one that did would be invisible to the scope ladder, to the kernel's bindings,
  and to the collision the registration validator exists to catch. Reach is
  refused at any other scope — those registrations outlive the surface, and a
  binding live wherever focus went would answer keys typed into the chat
  composer.
- **A layer's keys name their layer, and the deepest open one answers.** A
  layer-scoped contribution carries the `ChromeLayer` its `openLayer` handed
  back, so the merge reads `chrome.layers` rather than the order registrations
  arrived in: a dialog and the pane it opened are both `layer` scope, and the
  pane is the surface the writer is standing in. A decline falls past every
  layer to the outer scopes, never inward to the surface a deeper one covers.
  Keys registered before their layer exists — a suggestion menu's trigger binds
  the arrow keys a beat before React opens its popover — say `layer: null` and
  are the shallowest rung of the scope.
- **A collision is same place, same key, neither narrowing**, and registration
  refuses it. Anything else is the deliberate chain: different scopes are
  ordered by the ladder, different layers by depth, and an `appliesTo` pair by
  its own contexts, where declining hands the key down.
- **Undo stays highest.** The kernel mounts at TipTap priority 1050, under
  `UndoRedoKeymapExtension` at 1100 (ruling 17). Do not raise it.
- **`at-home` is a real answer.** When the editor has nothing left to give
  back, Esc is left unhandled so the browser, an IME, or a native dialog can
  still have it.
- **Escape reaches the chain three ways, and a surface has to pick one.** In
  the prose, ProseMirror's `handleKeyDown` runs it. Inside a Radix surface,
  Radix's own listener does, deferring through `onEscapeKeyDown`. Anywhere
  else — a hand-rolled portal, a margin handle holding a drag, any layer at all
  once focus has moved to the chat composer — the kernel's document backstop
  does. A surface that declares `"self"` without actually listening will survive
  Escape, and "nobody is ever trapped" stops being true quietly.
- **The backstop runs the same chain, minus the caret.** Off the prose it takes
  the gesture rung from anywhere (a drag runs with the pointer, and the hand
  that abandons it may have left focus on the control it grabbed) and a layer
  only when that layer expects the kernel to dismiss it. The two steps that
  move the caret are the prose's alone: off it the writer is typing somewhere
  else, and Escape is theirs there.
- **Opening a top-level layer closes the one that was open.** Law 4 lives in
  `openLayer`, so no surface needs a close call for a rival it cannot see. Say
  `parentId` for anything opened INSIDE another surface, or it will be read as
  a replacement.
- **A layer says who it is inside, not when it arrived.** React mounts child
  effects before parent effects, so registration order is the reverse of
  visual depth for the one case the design mandates (a new empty diagram opens
  with its source pane showing). Depth comes from `parentId`, which the React
  hook fills from context.
- **A scope is a place, not a priority.** `keymapScopeApplies` enforces it, so
  a table verb is unreachable in a paragraph whether or not its lane
  remembered to check.
- Object-ness is a registration in
  [`../objects/object-types.ts`](../objects/object-types.ts), never a
  structural guess. This module imports that table rather than re-deriving it.

## Anti-patterns

- A surface holding its own `useState` copy of the resolved context, its own
  `setTimeout` for hover reveal, or its own pointer listener. All three drift;
  read the kernel. `createHoverIntent` is deliberately not on `EditorChrome`
  for the third reason: a lane with its own intent has its own pointer.
- Reaching into `EditorChromeController`. It belongs to the extension.
- Widening `EditorChrome` with per-surface state. A lane's state is a lane's.
- Guarding a keymap contribution by re-reading the selection inside the
  binding. Say the scope, and narrow with `appliesTo` if the scope is too
  broad.
- Reading `event.defaultPrevented` to learn whether Escape was handled.
  ProseMirror calls `preventDefault` on keyCode 27 unconditionally, so the
  flag reports ProseMirror. Read the state the chain left behind.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) for the seam contracts six
  surface lanes build on
→ [`../objects/AGENTS.md`](../objects/AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §2 laws 3–7,
  §5.1 right-click split, §10 ruling 8. Ruling 11's native-menu fallback is
  superseded by the 2026-07-29 human ruling recorded above.
