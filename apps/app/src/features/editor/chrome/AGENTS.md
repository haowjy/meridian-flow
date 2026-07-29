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

- **`onCloseAutoFocus` → prose, on every surface, on every close path.** Radix
  restores focus to the trigger, which is right for a page and wrong for a
  manuscript: the writer never left the sentence, so the next Space must be a
  space. `useReturnFocusToProse` is the handler. This is the toolbar module's
  standing contract, and it applies to anything opened over the editor.
- **`onEscapeKeyDown` → `useChromeLayer(...).onEscapeKeyDown`.** Without it a
  single Esc closes a dialog and the pane inside it, spending two steps of the
  walk home on one key.
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
- **Chrome that portals out of the editor carries `data-editor-chrome`**, or
  right-clicks on it bypass the claim ladder.
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
