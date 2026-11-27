import { parseContextUri } from "@meridian/contracts/context-uri";
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";

import { startContextUpload, uploadContextFile } from "@/client/api/context-upload-api";
import { registerFileDropHost } from "@/core/editor/file-drop";

import { useEditorScope } from "../../editor-scope";

export function FileDropRuntime({
  editor,
  documentId,
  holderUri,
}: {
  editor: Editor | null;
  documentId: string;
  holderUri: string | null;
}) {
  const { projectId, workId, rootThreadId } = useEditorScope();
  const parsed = holderUri ? parseContextUri(holderUri) : null;
  const scheme = parsed?.ok ? parsed.value.scheme : null;

  useEffect(() => {
    if (!editor || !projectId || !scheme || scheme === "uploads" || rootThreadId) return;
    const query: Record<string, string> = workId ? { workId } : {};
    const target = (intakeId: string, file: File) => ({ projectId, scheme, query, intakeId, file });
    return registerFileDropHost(editor, {
      hostDocumentId: documentId,
      scheme,
      reserve: async ({ documentId: intakeId, file }) =>
        (await startContextUpload(target(intakeId, file))).name,
      send: ({ documentId: intakeId, file, signal, onProgress }) =>
        uploadContextFile({ ...target(intakeId, file), signal, onProgress }),
    });
  }, [editor, documentId, projectId, scheme, workId, rootThreadId]);

  return null;
}
