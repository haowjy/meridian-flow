import { t } from "@lingui/core/macro";
import type {
  UploadIntakeResult,
  UploadSignedPut,
  UploadStart,
} from "@meridian/contracts/protocol";

export type DirectUpload = {
  file: File;
  start(signal: AbortSignal | undefined): Promise<UploadStart>;
  /**
   * Idempotent. Aborting it only stops the waiting: a finish the server has received lands the
   * file all the same.
   */
  finish(signal: AbortSignal | undefined): Promise<UploadIntakeResult>;
  signal?: AbortSignal;
  onProgress?: (percent: number | null) => void;
};

export class UploadRefusedError extends Error {}

// XMLHttpRequest rather than fetch: only it reports bytes sent.
function putFile(
  put: UploadSignedPut,
  file: File,
  signal: AbortSignal | undefined,
  onProgress: DirectUpload["onProgress"],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => new DOMException("Upload was cancelled.", "AbortError");
    if (signal?.aborted) return reject(cancelled());
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", put.url);
    for (const [name, value] of Object.entries(put.headers)) xhr.setRequestHeader(name, value);
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.upload.onprogress = (event) =>
      onProgress?.(
        event.lengthComputable && event.total > 0
          ? Math.round((event.loaded / event.total) * 100)
          : null,
      );
    // A failed or expired PUT cannot be told apart in the browser (the store sends no CORS
    // headers on a refused request), so every failure reads the same.
    xhr.onerror = () => reject(new Error(t`The upload to storage failed.`));
    xhr.onabort = () => reject(cancelled());
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(t`The upload to storage failed.`));
    xhr.send(file);
  });
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export async function uploadFileDirect(upload: DirectUpload): Promise<UploadIntakeResult> {
  for (let attempt = 0; ; attempt += 1) {
    const started = await upload.start(upload.signal);
    if (started.state === "finalized") return started.result;
    try {
      if (started.state === "reserved")
        await putFile(started.put, upload.file, upload.signal, upload.onProgress);
      // Taken back while the bytes went up: no finish, so nothing lands.
      upload.signal?.throwIfAborted();
      return await upload.finish(upload.signal);
    } catch (error) {
      if (
        attempt > 0 ||
        isAbort(error) ||
        error instanceof UploadRefusedError ||
        upload.signal?.aborted
      )
        throw error;
    }
  }
}
