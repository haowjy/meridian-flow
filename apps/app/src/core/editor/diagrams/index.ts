/**
 * Fenced diagrams — the catalog, the shared render state, and the faces.
 *
 * A lane that wants to know whether a fence is a diagram asks the catalog; a
 * lane that draws one uses `useDiagramRender` and `DiagramBody`. A new diagram
 * kind is one row in `diagram-providers.ts` plus the renderer it names.
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
