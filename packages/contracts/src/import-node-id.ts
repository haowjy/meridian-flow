import { sha256 } from "@noble/hashes/sha2.js";

export function normalizeNamePath(path: string): string {
  // keep: Whole-path NFC is safe because / never composes with neighbours; segment-wise normalization must match
  return path.normalize("NFC");
}

export interface ImportNodeIdInput {
  projectId: string;
  importId: string;
  rootId: number;
  kind: "folder" | "entry" | "unreadable" | "derived";
  path: string;
}

const encoder = new TextEncoder();

function encode(input: ImportNodeIdInput): Uint8Array<ArrayBuffer> {
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

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

export function importNodeId(input: ImportNodeIdInput): string {
  const bytes = sha256(encode(input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // keep: Set UUIDv8 version bits so derived ids remain valid UUIDs
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // keep: Set RFC 4122 variant bits so derived ids remain valid UUIDs
  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
