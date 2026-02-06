/**
 * Content Adapters
 *
 * Public API for the content adapter system.
 */

export type {
  ContentAdapter,
  EditorCapabilities,
  EditorContentMap,
  EditorContent,
  TypedContentAdapter,
} from "./types";

export {
  getAdapter,
  getCapabilities,
  hasAdapter,
  registerAdapter,
} from "./registry";

export { markdownAdapter } from "./markdownAdapter";
export { latexAdapter } from "./latexAdapter";
export { plaintextAdapter } from "./plaintextAdapter";
