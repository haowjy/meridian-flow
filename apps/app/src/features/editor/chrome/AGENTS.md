# features/editor/chrome — chrome primitives

What every surface lane renders from: the object row, the themed Radix
wrappers, the mount host, and React's view of the kernel. Policy is headless
and lives in [`core/editor/chrome/`](../../../core/editor/chrome/AGENTS.md).

## Mental model

Three primitives and one host.

- **`OverlayIconRow`** — an object's verbs, overlaid just inside its top-right
  bounds (ruling 8; mockup 03b is the decision record). Portalled and
  positioned from the object's measured rect, so it has zero footprint.
- **`EditorMenu` / `EditorPopover` / `EditorDialog`** — Radix, subordinated.
  Each registers as a layer in the Esc chain, defers Escape when something
  deeper is open, and hands the caret back to the prose on every close path.
- **`EditorChromeHost`** — the one place chrome mounts. Surfaces arrive
  through `EDITOR_CHROME_SURFACES`; `EditorView.tsx` never learns about one.

Radix is not wrapped away. It keeps owning dismissal, outside-click, and
roving focus (decision 2026-07-29). What these add is subordination.

## Key rules

- **`onCloseAutoFocus` → `useChromeLayer(...).onCloseAutoFocus`.** Radix
  restores focus to the trigger, which is right for a page and wrong for a
  manuscript: the writer never left the sentence, so the next Space must be a
  space. The handler is layer-aware, and that part is load-bearing: a menu item
  that opens a form leaves the form behind, and handing the caret back then
  pulls focus out of a surface on the frame it appeared — which Radix reads as
  an outside interaction and dismisses. A close returns the caret only when it
  was the last thing on screen.
- **`onEscapeKeyDown` → `useChromeLayer(...).onEscapeKeyDown`.** Without it a
  single Esc closes a dialog and the pane inside it, spending two steps of the
  walk home on one key.
- **Wrap what a surface renders in `layer.scope(...)`.** That is how a layer
  opened inside another knows its parent, and depth is what orders the walk —
  React mounts child effects first, so arrival order says the opposite. A
  surface that skips it makes every layer inside it a sibling.
- **A Radix-backed layer declares `dismissal: "self"`; anything hand-rolled
  keeps the default.** The kernel's Escape backstop serves the default and
  stands aside for `"self"`, so declaring `"self"` without listening is how a
  writer gets stuck.
- **Chrome mounts for the active editor only.** The desktop context host keeps
  several editors warm behind the visible one and hides them with `hidden`,
  which does nothing to anything portalled.
- **`modal={false}`** on menus and popovers. A modal surface freezes the page
  behind it, and the page behind it is the writer's chapter: clicking away must
  land the caret where the writer clicked, not merely dismiss.
- **Anchoring is not re-implemented per lane.** A menu summoned by a place
  rather than a control hangs off `pointer-anchor.ts`. Its position is inline
  style, because a utility class that failed to reach it would silently drop
  every claimed menu in the top-left corner.
- **A surface keyed on a pointer point remounts when the point moves.** Radix
  positions through floating-ui's `autoUpdate`, which never sees a fixed anchor
  move; both wrappers already carry the key.
- **Chrome that portals out of the editor spreads
  `editorChromeAttributes(chrome)`**, or right-clicks on it bypass the claim
  ladder. The mark names the editor, because two documents open side by side
  are two kernels listening on one page.
- No raw color. Chip and row styling lives in `editor.css` under the kernel's
  banner; token classes elsewhere.

## Anti-patterns

- A lane rendering its own Radix root, its own anchor, or its own focus return.
- A lane adding a component to `EditorView.tsx` instead of a row to
  `chrome-surfaces.ts`.
- Local `useState` mirroring the resolved context or suppression.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../../core/editor/chrome/.context/CONTEXT.md`](../../../core/editor/chrome/.context/CONTEXT.md)
  for the seams and the Esc chain
→ [`../surfaces/toolbar/AGENTS.md`](../surfaces/toolbar/AGENTS.md)
