/**
 * The text of an EPUB or PDF, converted by the first `read` that needs it and kept beside the
 * original (`textObjectKey`), so a later read finds it. Derived files live and die with their
 * original (`derivedObjectKeys`).
 */
import {
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
  putDerivedObject,
  textObjectKey,
} from "../../storage/index.js";
import { convertToMarkdown } from "./convert.js";
import { CONVERSION_LIMITS, ConversionRefused } from "./limits.js";

export type TextSource = "epub" | "pdf";

export type ExtractedText =
  | { ok: true; markdown: string }
  | { ok: false; reason: ConversionRefused["reason"] | "missing"; message: string };

const TEXT_MIME_TYPE = "text/markdown; charset=utf-8";
/** The stored text is at most the output cap in characters; four bytes each is the worst case. */
const STORED_TEXT_MAX_BYTES = CONVERSION_LIMITS.outputChars * 4 + 1024;

export async function extractedText(
  objectStore: Pick<ObjectStorePort, "get" | "put" | "readHead" | "delete">,
  file: { storageUrl: string; source: TextSource },
): Promise<ExtractedText> {
  const originalKey = objectStoreKeyFromStorageUrl(file.storageUrl);
  if (!originalKey)
    return { ok: false, reason: "missing", message: "The file has no stored object." };
  const textKey = textObjectKey(originalKey);
  const stored = await objectStore.get(textKey, { maxBytes: STORED_TEXT_MAX_BYTES });
  if (stored.ok) return { ok: true, markdown: new TextDecoder().decode(stored.value.bytes) };
  if (stored.error.code !== "not_found")
    return { ok: false, reason: "unreadable", message: stored.error.message };

  const original = await objectStore.get(originalKey, {
    maxBytes: CONVERSION_LIMITS.originalBytes,
  });
  if (!original.ok)
    return {
      ok: false,
      reason: original.error.code === "too_large" ? "too_large" : "missing",
      message:
        original.error.code === "too_large"
          ? "The file is too large to read."
          : original.error.message,
    };
  try {
    const markdown = await convertToMarkdown(file.source, original.value.bytes);
    // Atomic, and the same bytes from a concurrent first read, so a lost race changes nothing.
    // A failed put costs only a conversion on the next read.
    await putDerivedObject(objectStore, {
      originalKey,
      key: textKey,
      bytes: new TextEncoder().encode(markdown),
      mimeType: TEXT_MIME_TYPE,
    });
    return { ok: true, markdown };
  } catch (error) {
    // Messages are ours, never the file's text.
    if (error instanceof ConversionRefused)
      return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
}
