import { parseContextUri } from "@meridian/contracts/context-uri";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo } from "react";

import { uploadContextFile } from "@/client/api/context-upload-api";
import {
  type ImageBytesPort,
  type ImageUploadPort,
  registerImageIngressHost,
} from "@/core/editor/images";

export function ImageIngressRuntime({
  editor,
  projectId,
  holderUri,
}: {
  editor: Editor | null;
  projectId: string | undefined;
  holderUri: string | null;
}) {
  const parsed = holderUri ? parseContextUri(holderUri) : null;
  const scheme = parsed?.ok ? (parsed.value.scheme === "user" ? "user" : "manuscript") : null;
  const upload = useMemo<ImageUploadPort | null>(
    () => (projectId && scheme ? pictureUploadPort(projectId, scheme) : null),
    [projectId, scheme],
  );

  useEffect(() => {
    if (!editor || !upload) return;
    return registerImageIngressHost(editor, { upload, fetchBytes: fetchImageBytes });
  }, [editor, upload]);

  return null;
}

function pictureUploadPort(projectId: string, scheme: "user" | "manuscript"): ImageUploadPort {
  return async ({ id, file, alt, signal, onProgress }) => {
    const stored = await uploadContextFile({
      projectId,
      scheme,
      query: {},
      intakeId: id,
      file,
      signal,
      onProgress,
    });
    return { src: `asset:${stored.documentId}`, alt: alt || null };
  };
}

/**
 * The bytes behind an address the clipboard carried.
 *
 * Only a `data:` image reaches this: a web picture pastes as a remote picture and is never
 * fetched. A failure leaves the link the paste landed, which is why nothing here throws.
 */
const fetchImageBytes: ImageBytesPort = async ({ url, filename, signal }) => {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) return null;
    return new File([blob], filename, { type: blob.type });
  } catch {
    return null;
  }
};
