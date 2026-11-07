/**
 * Reads of the writer's local files. A file on a stalled mount can leave a read pending for good,
 * so every read here gives up after `IMPORT_SCHEDULING.readTimeoutMs`; the caller treats a
 * rejection as "unreadable" (skip in a send, missing evidence in a report).
 */
import { IMPORT_SCHEDULING } from "./limits";

function within<T>(read: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Local read timed out")),
      IMPORT_SCHEDULING.readTimeoutMs,
    );
    read.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Rejects if the file cannot be read now: removed, unreadable, or not answering. Reads one byte. */
export async function probeReadable(file: File) {
  await within(file.slice(0, 1).arrayBuffer());
}

/** The hex SHA-256 the server stores in a receipt, so a re-picked file can be compared with it. */
export async function sha256File(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await within(file.arrayBuffer()));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
