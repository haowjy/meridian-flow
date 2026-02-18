/**
 * Content Adapter Registry
 *
 * Central registry for all content adapters.
 * Maps editor types to their respective adapters.
 */

import type { EditorType } from "../types/editorRegistry";
import type {
  EditorCapabilities,
  TypedContentAdapter,
  EditorContentMap,
} from "./types";
import { markdownAdapter } from "./markdownAdapter";
import { latexAdapter } from "./latexAdapter";
import { plaintextAdapter } from "./plaintextAdapter";

/**
 * Type-safe adapter map.
 * Maps each editor type to its corresponding adapter type.
 */
type AdapterMap = {
  [K in keyof EditorContentMap]: TypedContentAdapter<K>;
};

/**
 * Union type for all registered adapters.
 * Used for internal storage.
 */
type RegisteredAdapter = AdapterMap[keyof AdapterMap];

/**
 * Adapter registry mapping.
 * Add new adapters here as they're implemented.
 */
const adapters = new Map<EditorType, RegisteredAdapter>([
  ["markdown", markdownAdapter],
  ["latex", latexAdapter],
  ["plaintext", plaintextAdapter],
  // Future additions:
  // ['image', imageAdapter],
  // ['excalidraw', excalidrawAdapter],
  // ['mermaid', mermaidAdapter],
]);

/**
 * Get the content adapter for a specific editor type.
 *
 * @param type - Editor type
 * @returns ContentAdapter for the editor type
 * @throws Error if no adapter is registered for the type
 *
 * @example
 * const adapter = getAdapter('markdown')
 * const editorContent = adapter.toEditor(doc.content)
 */
export function getAdapter<T extends keyof AdapterMap>(type: T): AdapterMap[T];
export function getAdapter(type: EditorType): RegisteredAdapter;
export function getAdapter(type: EditorType): RegisteredAdapter {
  const adapter = adapters.get(type);
  if (!adapter) {
    throw new Error(`No adapter registered for editor type: ${type}`);
  }
  return adapter;
}

/**
 * Get the capabilities for a specific editor type.
 *
 * @param type - Editor type
 * @returns EditorCapabilities for the editor type
 *
 * @example
 * const capabilities = getCapabilities('markdown')
 * if (capabilities.editable) {
 *   // Show AI navigator
 * }
 */
export function getCapabilities(type: EditorType): EditorCapabilities {
  return getAdapter(type).capabilities;
}

/**
 * Check if an adapter is registered for an editor type.
 *
 * @param type - Editor type to check
 * @returns True if adapter is registered
 */
export function hasAdapter(type: EditorType): boolean {
  return adapters.has(type);
}

/**
 * Register a new content adapter (for future extensibility).
 *
 * @param adapter - Content adapter to register
 *
 * @example
 * registerAdapter(customAdapter)
 */
export function registerAdapter<T extends keyof AdapterMap>(
  adapter: AdapterMap[T],
): void {
  adapters.set(adapter.editorType, adapter);
}
