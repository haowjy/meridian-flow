/**
 * Content Adapter Pattern
 *
 * Adapters transform between storage format (backend) and editor format (frontend).
 * Each editor type has its own adapter to handle format-specific logic.
 */

import type { EditorType } from "../types/editorRegistry";

/**
 * Capabilities of an editor type.
 * Determines which features are available for this editor.
 */
export interface EditorCapabilities {
  /** Can show inline AI diff view (PUA markers or similar) */
  supportsAIDiff: boolean;

  /** Can track content versions (separate content + aiVersion) */
  supportsVersioning: boolean;

  /** Storage format type */
  contentFormat: "string" | "object" | "binary";

  /** Can be edited (vs read-only) */
  editable: boolean;
}

/**
 * Content adapter transforms between storage and editor formats.
 *
 * @template TStorage - Backend storage format (string, JSON object, etc.)
 * @template TEditor - Frontend editor format (merged document, image data, etc.)
 */
export interface ContentAdapter<TStorage, TEditor> {
  /** Editor type this adapter serves */
  editorType: EditorType;

  /** Transform storage format → editor format */
  toEditor(storage: TStorage, aiVersion?: TStorage | null): TEditor;

  /** Transform editor format → storage format */
  toStorage(editor: TEditor): { content: TStorage; aiVersion: TStorage | null };

  /** Check if editor content has AI suggestions */
  hasAISuggestions(editor: TEditor): boolean;

  /** Capabilities of this editor */
  capabilities: EditorCapabilities;
}

/**
 * Map editor types to their content formats.
 * Used for type-safe adapter implementations.
 */
export type EditorContentMap = {
  markdown: string;
  latex: string;
  plaintext: string;
  // Future additions:
  // image: ImageEditorFormat
  // excalidraw: ExcalidrawScene
};

/**
 * Get editor content type from editor type.
 * Provides type safety for adapter implementations.
 */
export type EditorContent<T extends EditorType> =
  T extends keyof EditorContentMap ? EditorContentMap[T] : unknown;

/**
 * Strongly-typed adapter interface.
 * Ensures adapter types match the editor content map.
 */
export interface TypedContentAdapter<
  T extends EditorType,
> extends ContentAdapter<string, EditorContent<T>> {
  editorType: T;
}
