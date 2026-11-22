import type { DocKey } from "./shape.js";

/**
 * The envelope (design §4): a room's update is a batch of `(docKey, bytes)` pairs, and a room's
 * version is the same shape with each doc's encoded version vector. `loro-protocol` carries both
 * as bytes it never decodes, so one envelope is one `DocUpdate` entry or one `version` field, and a
 * batch is imported and acknowledged as one.
 *
 * Layout: a format byte, a varint count, then per entry a varint-prefixed UTF-8 key and a
 * varint-prefixed payload. Keys are unique within an envelope.
 */
export type Envelope = ReadonlyMap<DocKey, Uint8Array>;

const FORMAT = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeEnvelope(entries: Envelope): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(FORMAT), varint(entries.size)];
  for (const [key, bytes] of entries) {
    const name = encoder.encode(key);
    parts.push(varint(name.length), name, varint(bytes.length), bytes);
  }
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Throws on bytes that are not an envelope: the room closes with the corrupt-update code. */
export function decodeEnvelope(bytes: Uint8Array): Map<DocKey, Uint8Array> {
  if (bytes[0] !== FORMAT) throw new EnvelopeError(`unknown envelope format ${bytes[0]}`);
  const reader = { bytes, at: 1 };
  const count = readVarint(reader);
  const out = new Map<DocKey, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const key = decoder.decode(readChunk(reader));
    if (out.has(key)) throw new EnvelopeError(`duplicate doc key ${key}`);
    out.set(key, readChunk(reader));
  }
  if (reader.at !== bytes.length) throw new EnvelopeError("trailing bytes after envelope");
  return out;
}

export class EnvelopeError extends Error {
  override name = "EnvelopeError";
}

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Uint8Array.from(out);
}

function readVarint(reader: { bytes: Uint8Array; at: number }): number {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (reader.at >= reader.bytes.length) throw new EnvelopeError("truncated envelope");
    const byte = reader.bytes[reader.at++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
    if (scale > 2 ** 49) throw new EnvelopeError("varint too long");
  }
}

function readChunk(reader: { bytes: Uint8Array; at: number }): Uint8Array {
  const length = readVarint(reader);
  if (reader.at + length > reader.bytes.length) throw new EnvelopeError("truncated envelope");
  const chunk = reader.bytes.subarray(reader.at, reader.at + length);
  reader.at += length;
  return chunk;
}
