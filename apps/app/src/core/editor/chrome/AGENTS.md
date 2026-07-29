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

Four things live here, and nothing else should:

- **The Esc chain.** `escStep` is the whole walk-home policy (law 3). A surface
  registers a layer while it is open and the chain decides whose turn it is.
- **The claim table.** An ordered ladder of right-click claimants. Not
  claiming is the designed outcome, not a gap.
- **Deepest-context resolution.** One answer to "what owns chrome right now",
  read by the Esc chain, the router, and the toolbar's greying.
- **Suppression and hover intent.** Approach chrome's timing, and standing
  down during a drag or sweep.

**Surface exclusivity is not here** (decision 2026-07-29). Radix already makes
menus, popovers, and dialogs mutually exclusive layers. Do not build a claim
or suppress arbiter beside it.

## Key rules

- **Native right-click is the default, not the fallback.** A `contextmenu`
  nobody claims is left completely alone: `preventDefault` is never called and
  the browser's menu opens with spellcheck in it (ruling 11). Claiming must be
  a positive act by a registered handler.
- **The claim decision is synchronous.** `preventDefault` after the event
  returns does nothing. Opening the surface may be deferred a tick; deciding
  may not.
- **Nothing binds Escape but the chain.** `mergeKeymapContributions` throws on
  it. A surface that wants a step in the walk registers a layer.
- **Undo stays highest.** The kernel mounts at TipTap priority 1050, under
  `UndoRedoKeymapExtension` at 1100 (ruling 17). Do not raise it.
- **`at-home` is a real answer.** When the editor has nothing left to give
  back, Esc is left unhandled so the browser, an IME, or a native dialog can
  still have it.
- **Escape reaches the chain three ways, and a surface has to pick one.** In
  the prose, ProseMirror's `handleKeyDown` runs it. Inside a Radix surface,
  Radix's own listener does, deferring through `onEscapeKeyDown`. Anywhere
  else — a hand-rolled portal, or any layer at all once focus has moved to the
  chat composer — the kernel's document backstop does, and only for layers
  registered `dismissal: "kernel"` (the default). A surface that declares
  `"self"` without actually listening will survive Escape, and "nobody is ever
  trapped" stops being true quietly.
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

- A surface holding its own `useState` copy of the resolved context, or its
  own `setTimeout` for hover reveal. Both drift; read the kernel.
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
  §5.1 right-click split, §10 rulings 8 and 11
