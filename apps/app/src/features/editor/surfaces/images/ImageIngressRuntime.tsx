/**
 * The app's half of image ingress: where a picture's bytes actually go.
 *
 * The editor owns the lifecycle — the slot, the progress, the failure, the
 * abort — and knows nothing about projects, figure endpoints, or CORS. This
 * component is that seam, the same shape as `ProjectLinkRuntime`: it registers
 * the two ports the ingress asks for.
 *
 * It renders nothing. What the writer sees while a drag is in the air, or when
 * a file is refused, is `ImageIngressOverlay`.
 */

import type { Editor } from "@tiptap/core";
import { useEffect, useMemo } from "react";

import { uploadFigure } from "@/client/api/figures-api";
import {
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
  const upload = useMemo<ImageUploadPort | null>(
    () => (projectId ? figureUploadPort(projectId, documentId) : null),
    [documentId, projectId],
  );

  useEffect(() => {
    if (!editor || !upload) return;
    return registerImageIngressHost(editor, { upload, fetchBytes: fetchImageBytes });
  }, [editor, upload]);

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
    const picture = imageAttrsFromUpload(reference);
    return { src: picture.src, alt: picture.alt };
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
