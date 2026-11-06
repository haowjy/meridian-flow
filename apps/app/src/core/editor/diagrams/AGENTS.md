# core/editor/diagrams — provider catalog and safe rendering

The catalog of diagram languages, provider render state and the sanitized SVG
boundary. What a provider owes is in `diagram-providers.ts`.

- Nothing outside the catalog names a diagram language: a `language === "mermaid"`
  predicate elsewhere is a parallel hierarchy. Ask `diagramProviderFor(node)` or the
  object registration.
- No per-provider render-state hook, debounce, face model or preview selector; the
  render hook, faces and `DIAGRAM_PREVIEW_SELECTOR` are shared.
- Only branded `SanitizedSvg` reaches the page. Provider strictness doesn't replace
  app sanitization.
- This module stays independent of object physics. Error-face actions are callbacks
  from the node view.

Render details: [`.context/CONTEXT.md`](.context/CONTEXT.md).
