/** Summarizes awareness updates without decoding their JSON state. */

import { createDecoder, readVarUint, readVarUint8Array } from "lib0/decoding";
import type { AwarenessClientDelta, AwarenessSummary } from "./types.js";

const NULL_STATE = new Uint8Array([0x6e, 0x75, 0x6c, 0x6c]);

function isNullState(bytes: Uint8Array): boolean {
  return (
    bytes.length === NULL_STATE.length && bytes.every((byte, index) => byte === NULL_STATE[index])
  );
}

export function summarizeAwareness(payload: Uint8Array): AwarenessSummary {
  const decoder = createDecoder(payload);
  const count = readVarUint(decoder);
  const clients: AwarenessClientDelta[] = [];

  for (let index = 0; index < count; index += 1) {
    const client = readVarUint(decoder);
    const clock = readVarUint(decoder);
    // Awareness state is a JSON var-string. Reading its raw bytes avoids ever
    // turning writer-controlled state into a JavaScript string.
    const stateBytes = readVarUint8Array(decoder);
    clients.push({ client, clock, removed: isNullState(stateBytes) });
  }

  if (decoder.pos !== payload.byteLength) throw new Error("Unexpected trailing awareness bytes");

  return {
    clients,
    count,
    removedCount: clients.filter((client) => client.removed).length,
    bytes: payload.byteLength,
  };
}
