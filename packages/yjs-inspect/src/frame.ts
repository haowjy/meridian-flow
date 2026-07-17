/** Classifies Hocuspocus frames without decoding their content. */

import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import type { FrameSummary, InnerSyncType, YjsMessageClass } from "./types.js";

const OUTER_SYNC = 0;
const OUTER_AWARENESS = 1;
const OUTER_AUTH = 2;
const OUTER_QUERY_AWARENESS = 3;
const OUTER_SYNC_REPLY = 4;
const OUTER_STATELESS = 5;

const INNER_SYNC_TYPES: Readonly<Record<number, InnerSyncType>> = {
  0: "step1",
  1: "step2",
  2: "update",
};

const SYNC_MESSAGE_CLASSES: Readonly<Record<InnerSyncType, YjsMessageClass>> = {
  step1: "sync.step1",
  step2: "sync.step2",
  update: "sync.update",
};

function unknown(bytes: Uint8Array, documentName: string | null = null): FrameSummary {
  return {
    documentName,
    messageClass: "unknown",
    payloadBytes: bytes.byteLength,
  };
}

export function classifyFrame(bytes: Uint8Array): FrameSummary {
  let documentName: string | null = null;

  try {
    const decoder = createDecoder(bytes);
    documentName = readVarString(decoder);
    const outerType = readVarUint(decoder);

    if (outerType === OUTER_SYNC || outerType === OUTER_SYNC_REPLY) {
      const innerSyncType = INNER_SYNC_TYPES[readVarUint(decoder)];
      if (!innerSyncType) return unknown(bytes, documentName);

      const payload = readVarUint8Array(decoder);
      if (decoder.pos !== bytes.byteLength) return unknown(bytes, documentName);

      return {
        documentName,
        messageClass: SYNC_MESSAGE_CLASSES[innerSyncType],
        innerSyncType,
        payloadBytes: payload.byteLength,
      };
    }

    if (outerType === OUTER_AWARENESS) {
      const payload = readVarUint8Array(decoder);
      if (decoder.pos !== bytes.byteLength) return unknown(bytes, documentName);
      return { documentName, messageClass: "awareness", payloadBytes: payload.byteLength };
    }

    if (outerType === OUTER_QUERY_AWARENESS) {
      if (decoder.pos !== bytes.byteLength) return unknown(bytes, documentName);
      return { documentName, messageClass: "awareness", payloadBytes: 0 };
    }

    if (outerType === OUTER_STATELESS) {
      // A lib0 string and byte array share the same length-prefixed envelope.
      // Read bytes so observer code never materializes the stateless content.
      const payload = readVarUint8Array(decoder);
      if (decoder.pos !== bytes.byteLength) return unknown(bytes, documentName);
      return { documentName, messageClass: "stateless", payloadBytes: payload.byteLength };
    }

    if (outerType === OUTER_AUTH) {
      if (decoder.pos >= bytes.byteLength) return unknown(bytes, documentName);
      return {
        documentName,
        messageClass: "auth",
        payloadBytes: bytes.byteLength - decoder.pos,
      };
    }

    return unknown(bytes, documentName);
  } catch {
    return unknown(bytes, documentName);
  }
}
