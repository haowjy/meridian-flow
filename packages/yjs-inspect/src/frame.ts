/** Inspects Hocuspocus frames without exposing their content. */

import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import { summarizeAwareness } from "./awareness.js";
import type {
  AwarenessSummary,
  FrameInspection,
  FrameSummary,
  InnerSyncType,
  YjsMessageClass,
} from "./types.js";
import { summarizeUpdate } from "./update.js";

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

interface DecodedFrame {
  summary: FrameSummary;
  payload?: Uint8Array;
  queryAwareness?: boolean;
}

function decodeFrame(bytes: Uint8Array): DecodedFrame {
  let documentName: string | null = null;

  try {
    const decoder = createDecoder(bytes);
    documentName = readVarString(decoder);
    const outerType = readVarUint(decoder);

    if (outerType === OUTER_SYNC || outerType === OUTER_SYNC_REPLY) {
      const innerSyncType = INNER_SYNC_TYPES[readVarUint(decoder)];
      if (!innerSyncType) return { summary: unknown(bytes, documentName) };

      const payload = readVarUint8Array(decoder);
      if (decoder.pos !== bytes.byteLength) return { summary: unknown(bytes, documentName) };

      return {
        summary: {
          documentName,
          messageClass: SYNC_MESSAGE_CLASSES[innerSyncType],
          innerSyncType,
          payloadBytes: payload.byteLength,
        },
        payload,
      };
    }

    if (outerType === OUTER_AWARENESS) {
      const payload = readVarUint8Array(decoder);
      if (decoder.pos !== bytes.byteLength) return { summary: unknown(bytes, documentName) };
      return {
        summary: { documentName, messageClass: "awareness", payloadBytes: payload.byteLength },
        payload,
      };
    }

    if (outerType === OUTER_QUERY_AWARENESS) {
      if (decoder.pos !== bytes.byteLength) return { summary: unknown(bytes, documentName) };
      return {
        summary: { documentName, messageClass: "awareness", payloadBytes: 0 },
        queryAwareness: true,
      };
    }

    if (outerType === OUTER_STATELESS) {
      // A lib0 string and byte array share the same length-prefixed envelope.
      // Read bytes so observer code never materializes the stateless content.
      const payload = readVarUint8Array(decoder);
      if (decoder.pos !== bytes.byteLength) return { summary: unknown(bytes, documentName) };
      return {
        summary: { documentName, messageClass: "stateless", payloadBytes: payload.byteLength },
      };
    }

    if (outerType === OUTER_AUTH) {
      const payloadStart = decoder.pos;
      readVarUint(decoder);
      return {
        summary: {
          documentName,
          messageClass: "auth",
          payloadBytes: bytes.byteLength - payloadStart,
        },
      };
    }

    return { summary: unknown(bytes, documentName) };
  } catch {
    return { summary: unknown(bytes, documentName) };
  }
}

export function classifyFrame(bytes: Uint8Array): FrameSummary {
  return decodeFrame(bytes).summary;
}

export function inspectFrame(bytes: Uint8Array): FrameInspection {
  const decoded = decodeFrame(bytes);
  const inspection: FrameInspection = { frame: decoded.summary };

  try {
    if (
      decoded.payload &&
      (decoded.summary.messageClass === "sync.step2" ||
        decoded.summary.messageClass === "sync.update")
    ) {
      inspection.update = summarizeUpdate(decoded.payload);
    } else if (decoded.queryAwareness) {
      inspection.awareness = emptyAwarenessSummary();
    } else if (decoded.payload && decoded.summary.messageClass === "awareness") {
      inspection.awareness = summarizeAwareness(decoded.payload);
    }
  } catch {
    // A valid outer envelope can still contain a malformed Yjs payload. Frame
    // inspection is observational, so preserve its classification and omit
    // only the undecodable nested summary.
  }

  return inspection;
}

function emptyAwarenessSummary(): AwarenessSummary {
  return { clients: [], count: 0, removedCount: 0, bytes: 0 };
}
