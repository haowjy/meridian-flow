/**
 * The app's half of image ingress: where a picture's bytes actually go.
 *
 * The editor owns the lifecycle — the slot, the progress, the failure, the
 * abort — and knows nothing about projects, figure endpoints, or CORS. This
 * component is that seam, the same shape as `ProjectLinkRuntime`: it registers
 * the two ports the ingress asks for and feeds the editor's asset index from
 * the project tree the app already caches.
 *
 * It renders nothing. What the writer sees while a drag is in the air, or when
 * a file is refused, is `ImageIngressOverlay`.
 */

import type { Editor } from "@tiptap/core";
import { useEffect, useMemo } from "react";

import { uploadFigure } from "@/client/api/figures-api";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import {
  editorAssetIndex,
  type ImageBytesPort,
  type ImageUploadPort,
  imageAttrsFromUpload,
  registerImageIngressHost,
} from "@/core/editor/images";

export function ImageIngressRuntime({
  editor,
  projectId,
  documentId,
}: {
  editor: Editor | null;
  projectId: string | undefined;
  documentId: string;
}) {
  const { catalog: manuscriptCatalog } = useContextCatalogView(projectId ?? "", "manuscript", {
    enabled: Boolean(projectId),
    workId: null,
  });

  const upload = useMemo<ImageUploadPort | null>(
    () => (projectId ? figureUploadPort(projectId, documentId) : null),
    [documentId, projectId],
  );

  useEffect(() => {
    if (!editor || !upload) return;
    return registerImageIngressHost(editor, { upload, fetchBytes: fetchImageBytes });
  }, [editor, upload]);

  // Pictures already in the project: the clipboard translates paths to refs in
  // both directions, and it can only do that for assets it has been told about.
  useEffect(() => {
    const assetIndex = editorAssetIndex(editor);
    if (!assetIndex || !manuscriptCatalog) return;
    for (const file of manuscriptCatalog.files()) {
      if (!file.editable && file.fileType === "image") {
        assetIndex.remember(file.documentId, file.path.replace(/^\//, ""));
      }
    }
  }, [editor, manuscriptCatalog]);

  return null;
}

/** One project's figure endpoint, as the port the ingress calls. */
function figureUploadPort(projectId: string, hostDocumentId: string): ImageUploadPort {
  return async ({ file, alt, signal, onProgress }) => {
    const reference = await uploadFigure({
      projectId,
      hostDocumentId,
      file,
      alt,
      signal,
      onProgress: ({ percent }) => onProgress(percent),
    });
    const attrs = imageAttrsFromUpload(reference);
    return {
      src: attrs.src,
      alt: attrs.alt,
      assetDocumentId: reference.assetDocumentId,
      assetPath: reference.assetPath,
    };
  };
}

/**
 * The bytes behind an address the clipboard carried.
 *
 * A cross-origin image served without CORS headers is the ordinary answer, not
 * a failure worth explaining away: most of the web declines. The link the paste
 * landed is what the writer keeps in that case, which is why nothing here
 * throws.
 */
const fetchImageBytes: ImageBytesPort = async ({ url, filename, signal }) => {
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit", signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return null;
    return new File([blob], filename, { type: blob.type });
  } catch {
    return null;
  }
};
