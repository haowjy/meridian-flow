/**
 * Sends a file to the object store by a signed PUT, between two calls to the server: `start`
 * reserves the upload and signs the PUT, `finish` reads the stored bytes back and makes the file
 * visible. The server never sees the bytes in between.
 *
 * What a destination changes is `start` and `finish`; this function is the same for all of them.
 */
import { t } from "@lingui/core/macro";
import type {
  UploadIntakeResult,
  UploadSignedPut,
  UploadStart,
} from "@meridian/contracts/protocol";

export type DirectUpload = {
  file: File;
  /** Reserves the upload, or resumes it: calling again returns the state it has reached. */
  start(): Promise<UploadStart>;
  /** Idempotent. */
  finish(): Promise<UploadIntakeResult>;
  signal?: AbortSignal;
  /** Whole percents of the PUT, or null where the browser cannot say how much there is to send. */
  onProgress?: (percent: number | null) => void;
};

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

/**
 * Start, PUT, finish. A PUT or finish that fails is tried once more from the start, which signs a
 * fresh URL and skips the PUT if the bytes are already stored. An error from `start` itself
 * (a refused name or size) is final.
 */
export async function uploadFileDirect(upload: DirectUpload): Promise<UploadIntakeResult> {
  for (let attempt = 0; ; attempt += 1) {
    const started = await upload.start();
    if (started.state === "finalized") return started.result;
    try {
      if (started.state === "reserved")
        await putFile(started.put, upload.file, upload.signal, upload.onProgress);
      return await upload.finish();
    } catch (error) {
      if (attempt > 0 || isAbort(error) || upload.signal?.aborted) throw error;
    }
  }
}
