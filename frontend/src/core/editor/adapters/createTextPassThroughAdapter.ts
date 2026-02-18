import type { EditorContent, TypedContentAdapter } from "./types";

type TextEditorType = "markdown" | "plaintext" | "latex";

export function createTextPassThroughAdapter<T extends TextEditorType>(
  editorType: T,
): TypedContentAdapter<T> {
  return {
    editorType,
    toEditor(content: string): EditorContent<T> {
      return content as EditorContent<T>;
    },
    toStorage(editor: EditorContent<T>): { content: string } {
      return { content: editor as string };
    },
    capabilities: {
      contentFormat: "string",
      editable: true,
    },
  };
}
