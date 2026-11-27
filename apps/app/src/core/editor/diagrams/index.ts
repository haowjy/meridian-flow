/**
 * Fenced diagrams — the catalog, the shared render state, and the faces.
 *
 * A lane that wants to know whether a fence is a diagram asks the catalog; a
 * lane that draws one uses `useDiagramRender` and `DiagramBody`. A new diagram
 * kind is one row in `diagram-providers.ts` plus the renderer it names.
 *
 * `SanitizedSvg` is the type markup wears once it has been through the
 * rendering boundary. It is exported for the lanes that hold rendered markup —
 * a lightbox, an export verb — so what they hold says where it came from;
 * `sanitizeSvg` itself is deliberately not, because a second caller would be a
 * second boundary.
 */

export { DIAGRAM_PREVIEW_SELECTOR, DiagramBody } from "./DiagramBody";
export {
  type DiagramProvider,
  defaultDiagramProvider,
  diagramProviderFor,
  diagramProviderForLanguage,
  EDITOR_DIAGRAM_PROVIDERS,
} from "./diagram-providers";
export {
  type DiagramFace,
  type DiagramRender,
  diagramFace,
  useDiagramRender,
} from "./diagram-render-state";
export type { SanitizedSvg } from "./sanitized-svg";
