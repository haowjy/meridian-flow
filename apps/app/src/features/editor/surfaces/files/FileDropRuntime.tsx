/**
 * The app's half of dropping a file into a document: where its bytes go.
 *
 * The editor owns the chip; the upload store owns its progress and taking it
 * back. Neither knows projects or endpoints. This registers the host it asks for, the
 * same shape as `ImageIngressRuntime`, and renders nothing. A file lands in
 * `assets/` of the document's own source, so a document without a source of
 * its own (a chat's uploads are flat) registers no host and refuses files.
 */

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
  /** The document's own address; its scheme is the source its files land in. */
  holderUri: string | null;
}) {
  const { projectId, workId, rootThreadId } = useEditorScope();
  const parsed = holderUri ? parseContextUri(holderUri) : null;
  const scheme = parsed?.ok ? parsed.value.scheme : null;

  useEffect(() => {
    // A chat lineage's Scratch is the model's to create in, so a writer's files are refused there.
    if (!editor || !projectId || !scheme || scheme === "uploads" || rootThreadId) return;
    const query: Record<string, string> = workId ? { workId } : {};
    const target = (intakeId: string, file: File) => ({ projectId, scheme, query, intakeId, file });
    return registerFileDropHost(editor, {
      hostDocumentId: documentId,
      scheme,
      reserve: async ({ documentId: intakeId, file }) => {
        await startContextUpload(target(intakeId, file));
      },
      send: ({ documentId: intakeId, file, signal, onProgress }) =>
        uploadContextFile({ ...target(intakeId, file), signal, onProgress }),
    });
  }, [editor, documentId, projectId, scheme, workId, rootThreadId]);

  return null;
}
