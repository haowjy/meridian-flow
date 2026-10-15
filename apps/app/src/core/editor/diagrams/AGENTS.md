# core/editor/diagrams — provider catalog and safe rendering

This directory owns the catalog of diagram languages, provider render state,
and the sanitized SVG boundary. The code-block node view renders the result;
feature surfaces own diagram verbs.

## Mental model

A diagram provider is one catalog row plus one renderer: language, display name,
starter source, and async `render(id, source)`. Object registration, slash
catalog entries, the node-view faces, and surface verbs project from that row.
No consumer may maintain a second language list or branch on a language string.

## Rules

- Renderers return raw SVG or a writer-readable error. `useDiagramRender` owns
  ordering, provider-keyed state, palette redraw, and sanitization.
- Only branded `SanitizedSvg` reaches the page. The SVG allow-list excludes
  HTML `foreignObject`; provider strictness is not a substitute for app
  sanitization.
- The render layer is keyed by provider so a language change cannot reuse old
  state. Source is visible only when the node view's selection requires it.
- Nothing outside the catalog names a diagram language. A
  `language === "mermaid"` predicate elsewhere is the parallel hierarchy this
  module replaced; ask `diagramProviderFor(node)` or the object registration.
  Likewise no per-provider render-state hook, debounce, face model, or preview
  selector: the render hook, faces, and `DIAGRAM_PREVIEW_SELECTOR` are shared.
- A renderer's error message is shown verbatim on the stale and unrendered
  faces, so it names the problem, not the stack.
- This module stays independent of object physics. Error-face actions are
  callbacks supplied by the node view.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — render/error-face details
→ [`../objects/AGENTS.md`](../objects/AGENTS.md) — generated object physics
→ [`../../../features/editor/surfaces/objects/AGENTS.md`](../../../features/editor/surfaces/objects/AGENTS.md) — diagram verbs
