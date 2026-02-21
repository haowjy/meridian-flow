import {
  getAdapter,
  type EditorContentMap,
} from "@/core/editor/adapters";
import {
  detectEditorType,
  type EditorType,
} from "@/core/editor/types/editorRegistry";

type AdapterBackedEditorType = keyof EditorContentMap;

const DEFAULT_EDITOR_TYPE: AdapterBackedEditorType = "markdown";

/**
 * Boundary for storage/editor conversion used by document hooks.
 * Keeps sync and hydration logic independent from specific adapter internals.
 */
export interface DocumentContentDriver<TEditor> {
  emptyContent: TEditor;
  toEditor(storageContent: string): TEditor;
  toStorage(editorContent: TEditor): string;
}

function isAdapterBackedEditorType(
  editorType: EditorType,
): editorType is AdapterBackedEditorType {
  return (
    editorType === "markdown" ||
    editorType === "latex" ||
    editorType === "plaintext"
  );
}

function resolveAdapterBackedEditorType(
  extension: string,
): AdapterBackedEditorType {
  const editorType = detectEditorType(extension);
  if (isAdapterBackedEditorType(editorType)) {
    return editorType;
  }

  console.warn(
    `[documentContentDriver] Unsupported editor type "${editorType}" for extension "${extension}". Falling back to "${DEFAULT_EDITOR_TYPE}".`,
  );
  return DEFAULT_EDITOR_TYPE;
}

function createTextAdapter(extension: string) {
  const editorType = resolveAdapterBackedEditorType(extension);
  return getAdapter(editorType);
}

export function createTextDocumentContentDriver(
  extension: string,
): DocumentContentDriver<string> {
  const adapter = createTextAdapter(extension);
  return {
    emptyContent: "",
    toEditor(storageContent: string): string {
      return adapter.toEditor(storageContent);
    },
    toStorage(editorContent: string): string {
      return adapter.toStorage(editorContent).content;
    },
  };
}
