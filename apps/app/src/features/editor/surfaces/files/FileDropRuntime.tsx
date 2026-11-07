/**
 * The app's half of dropping a file into a document: where its bytes go.
 *
 * The editor owns the chip, its progress and taking the upload back; it knows
 * nothing of projects or endpoints. This registers the host it asks for, the
 * same shape as `ImageIngressRuntime`, and renders nothing. A file lands in
 * `assets/` of the document's own source, so a document without a source of
 * its own (a chat's uploads are flat) registers no host and refuses files.
 */

import { parseContextUri } from "@meridian/contracts/context-uri";
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";

import { startSourceUpload, uploadSourceFile } from "@/client/api/source-upload-api";
import { registerFileDropHost } from "@/core/editor/file-drop";

import { useEditorScope } from "../../editor-scope";

export function FileDropRuntime({
  editor,
  documentId,
  holderUri,
}: {
  editor: Editor | null;
  documentId: string;
  /** The document's own address; its scheme is the source its files land in. */
  holderUri: string | null;
}) {
  const { projectId, workId, rootThreadId } = useEditorScope();
  const parsed = holderUri ? parseContextUri(holderUri) : null;
  const scheme = parsed?.ok ? parsed.value.scheme : null;

  useEffect(() => {
    // A chat lineage's Scratch is the model's to create in, so a writer's files are refused there.
    if (!editor || !projectId || !scheme || scheme === "uploads" || rootThreadId) return;
    const owner = workId ? { workId } : null;
    return registerFileDropHost(editor, {
      hostDocumentId: documentId,
      scheme,
      start: async ({ documentId: fileDocumentId, file }) => {
        const target = { projectId, scheme, owner, documentId: fileDocumentId, file };
        const started = await startSourceUpload(target);
        return (signal, onProgress) => uploadSourceFile({ ...target, started, signal, onProgress });
      },
    });
  }, [editor, documentId, projectId, scheme, workId, rootThreadId]);

  return null;
}
