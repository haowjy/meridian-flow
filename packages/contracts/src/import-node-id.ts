/**
 * The id a planned import node gets, derived from where it sits in the selection.
 *
 * The server plan and the browser's predicted rows both call this, so a row has its
 * final id from the moment the writer picks. The server is authoritative: it derives
 * every id itself, so a client cannot name an existing document's id.
 */

/** NFC on every segment of a `/` path; no dot-segment folding or percent decoding. */
export function normalizeNamePath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
}

export interface ImportNodeIdInput {
  projectId: string;
  importId: string;
  rootId: number;
  kind: "folder" | "entry" | "unreadable";
  /** "/"-separated; "" for the root folder. */
  path: string;
}

/** Length-prefixed so no field can run into the next. */
function encode(input: ImportNodeIdInput): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const fields = [
    input.projectId,
    input.importId,
    String(input.rootId),
    input.kind,
    normalizeNamePath(input.path),
  ].map((field) => encoder.encode(field));
  const out = new Uint8Array(fields.reduce((sum, field) => sum + 4 + field.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const field of fields) {
    view.setUint32(at, field.length);
    out.set(field, at + 4);
    at += 4 + field.length;
  }
  return out;
}

export async function importNodeId(input: ImportNodeIdInput): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encode(input)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
