/**
 * The id a planned import node gets, derived from where it sits in the selection.
 *
 * The server plan and the browser's predicted rows both call this, so a row has its
 * final id from the moment the writer picks. The server is authoritative: it derives
 * every id itself, so a client cannot name an existing document's id.
 */

/** NFC on every segment of a `/` path; no dot-segment folding or percent decoding. */
export function normalizeNamePath(path: string): string {
  // "/" never composes with its neighbours, so one pass equals segment-wise NFC.
  return path.normalize("NFC");
}

export interface ImportNodeIdInput {
  projectId: string;
  importId: string;
  rootId: number;
  kind: "folder" | "entry" | "unreadable";
  /** "/"-separated; "" for the root folder. */
  path: string;
}

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** Length-prefixed so no field can run into the next. */
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

/** SHA-256 of `bytes`; synchronous because a 10,000-node pick would otherwise cost 10,000 awaited WebCrypto digests. */
const w = new Uint32Array(64);

function sha256(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const h = Uint32Array.from(H0);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]);
  return out;
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

export function importNodeId(input: ImportNodeIdInput): string {
  const bytes = sha256(encode(input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
