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

export async function probeReadable(file: File) {
  await within(file.slice(0, 1).arrayBuffer());
}

export async function sha256File(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await within(file.arrayBuffer()));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
