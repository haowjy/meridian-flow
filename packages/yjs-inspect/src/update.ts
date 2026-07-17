/** Summarizes Yjs updates into stable correlation and size metadata. */

import { digest } from "lib0/hash/sha256";
import * as Y from "yjs";
import type { UpdateClientRange, UpdateSummary } from "./types.js";

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function summarizeUpdate(update: Uint8Array): UpdateSummary {
  const meta = Y.parseUpdateMeta(update);
  const decoded = Y.decodeUpdate(update);
  const clients: UpdateClientRange[] = Array.from(meta.to, ([client, clockTo]) => ({
    client,
    clockFrom: meta.from.get(client) ?? clockTo,
    clockTo,
  })).sort((left, right) => left.client - right.client);
  const structCount = decoded.structs.length;
  const deleteSetSize = Array.from(decoded.ds.clients.values()).reduce(
    (total, ranges) => total + ranges.reduce((subtotal, range) => subtotal + range.len, 0),
    0,
  );

  return {
    clients,
    structCount,
    deleteSetSize,
    isNoop: structCount === 0 && deleteSetSize === 0,
    bytes: update.byteLength,
    updateHash: toHex(digest(update)).slice(0, 16),
  };
}
