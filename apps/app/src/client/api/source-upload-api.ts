/**
 * The one function that sends a file dropped into a document to its project.
 *
 * Everything else about a dropped file (the chip, its progress, the destination) is the same
 * whichever way the bytes travel, so the transport is this module's alone: swapping it for a signed
 * PUT to the store changes this function and nothing around it.
 */
import { t } from "@lingui/core/macro";
import { fileTooLargeMessage } from "@/lib/upload-limit";

import { errorMessageFromPayload } from "./http-client";

export type SourceUploadInput = {
  projectId: string;
  /** The host document's source: the file lands in that source's `assets/`. */
  scheme: string;
  /** Which Scratch a `scratch` host means: a Work, or a chat's lineage. */
  owner: { workId: string } | { rootThreadId: string } | null;
  /** Minted by the caller: the link to the file stands in the document before the file does. */
  documentId: string;
  file: File;
  signal: AbortSignal;
  /** Whole percents, or null where the browser cannot say how much there is to send. */
  onProgress: (percent: number | null) => void;
};

function parse(xhr: XMLHttpRequest): unknown {
  if (!xhr.responseText) return null;
  try {
    return JSON.parse(xhr.responseText) as unknown;
  } catch {
    return xhr.responseText;
  }
}

function failure(status: number, payload: unknown, name: string): Error {
  const message =
    typeof payload === "object" && payload && "message" in payload ? payload.message : null;
  if (message === "too_large") return new Error(fileTooLargeMessage(name));
  if (message === "invalid_filename")
    return new Error(
      t`This filename contains unsupported characters. Rename the file and try again.`,
    );
  return new Error(errorMessageFromPayload(payload, status));
}

// XMLHttpRequest rather than fetch: only it reports bytes sent.
export function uploadSourceFile(input: SourceUploadInput): Promise<void> {
  const { projectId, scheme, owner, documentId, file, signal } = input;
  const query = new URLSearchParams({ documentId, filename: file.name });
  if (owner && "workId" in owner) query.set("workId", owner.workId);
  if (owner && "rootThreadId" in owner) query.set("rootThreadId", owner.rootThreadId);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload was cancelled.", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/context/${encodeURIComponent(scheme)}/upload?${query}`,
    );
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.upload.onprogress = (event) =>
      input.onProgress(
        event.lengthComputable && event.total > 0
          ? Math.round((event.loaded / event.total) * 100)
          : null,
      );
    xhr.onerror = () => reject(new Error(t`Couldn't reach the server. Check your connection.`));
    xhr.onabort = () => reject(new DOMException("Upload was cancelled.", "AbortError"));
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(failure(xhr.status, parse(xhr), file.name));
    xhr.send(file);
  });
}
