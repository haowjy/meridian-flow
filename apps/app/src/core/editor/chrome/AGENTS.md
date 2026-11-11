# core/editor/chrome — headless chrome kernel

Editor-wide control-surface policy: context claims, the Escape chain, key scopes,
hover approach and gesture suppression. React surfaces live in
[`features/editor/chrome/`](../../../features/editor/chrome/AGENTS.md).

- Escape is one chain. A surface registers a layer or gesture cancellation; a
  private Escape listener competes with it. Suggestion hosts register semantic
  retreat rather than an Escape binding.
- A layer's parent determines depth, not registration order: child effects may run
  first, so a child provides `parentId`.
- Don't re-read the selection inside a keymap binding to guard it; declare the scope
  and narrow with `appliesTo`.
- Radix owns exclusivity among visible layers, so don't build a claim or suppress
  arbiter beside it. A hovered target isn't a layer, and one block owns hover chrome
  at a time.
- One kernel-owned hover answer re-hits the remembered pointer after layout or scroll
  changes. Lanes contribute target-specific facts; private timers and pointer
  listeners create competing answers.

Reach, scope, collision and backstop contracts:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
