# core/editor/chrome — headless chrome kernel

This directory owns editor-wide control-surface policy: context claims, the
Escape chain, key scopes, hover approach, and gesture suppression. It renders
nothing; React surfaces live in [`features/editor/chrome/`](../../../features/editor/chrome/AGENTS.md).

## Mental model

One `EditorChrome` store is created by `ChromeKernelExtension`. Surfaces register
layers and contributions; pure policy beside the store decides which one wins.
Radix owns exclusivity among visible layers. The kernel owns the separate
question of which block receives approach chrome.

## Rules

- Right-click claims synchronously through the ordered context ladder. The
  ladder ends at a caret menu; Shift+right-click always reaches the browser.
  Opening may defer, but `preventDefault()` cannot.
- Escape is one chain. Surfaces register a layer or gesture cancellation;
  they do not bind private Escape listeners. ProseMirror, Radix, and the
  document backstop all invoke the same chain. At home it remains unhandled.
- Suggestion hosts register semantic retreat (`backtrack`, then root
  dismissal), not an Escape binding. A pending owner covers the interval before
  its layer registers. Deeper layers and active gestures win.
- A layer's parent determines depth, not React registration order. Opening a
  top-level layer replaces its sibling; a child must provide `parentId`.
- Key scopes are places, not priorities. Layer reach is allowed only for the
  layer that supplied it; collisions at the same place and key are rejected.
  Undo remains above the kernel.
- One kernel-owned hover answer re-hits the remembered pointer after layout or
  scroll changes. Lanes contribute target-specific facts only. Persistent
  selection chrome is lane state, not hover state.
- Do not build a claim or suppress arbiter for surface exclusivity beside
  Radix. Approach exclusivity is a different question: a hovered target is not a
  layer, so one block owns hover chrome at a time and its pieces compose on it.
- Do not guard a keymap contribution by re-reading the selection inside the
  binding; declare the scope and narrow with `appliesTo`.
- Object-ness comes from [`../objects/object-types.ts`](../objects/object-types.ts);
  do not infer it from node types or selections here.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — reach, scope, collision, and
  backstop contracts
→ [`../objects/AGENTS.md`](../objects/AGENTS.md) — registration-driven physics
