/** Inspects Hocuspocus frames without exposing their content. */

import {
  createDecoder,
  readVarInt,
  readVarString,
  readVarUint,
  readVarUint8Array,
} from "lib0/decoding";
import { summarizeAwareness } from "./awareness.js";
import type {
  AwarenessSummary,
  FrameInspection,
  FrameSummary,
  InnerSyncType,
  SyncFrameSummary,
} from "./types.js";
import { summarizeUpdate } from "./update.js";

const OUTER_SYNC = 0;
const OUTER_AWARENESS = 1;
const OUTER_AUTH = 2;
const OUTER_QUERY_AWARENESS = 3;
const OUTER_SYNC_REPLY = 4;
const OUTER_STATELESS = 5;
const OUTER_CLOSE = 7;
const OUTER_SYNC_STATUS = 8;
const OUTER_PING = 9;
const OUTER_PONG = 10;

const INNER_SYNC_TYPES: Readonly<Record<number, InnerSyncType>> = {
  0: "step1",
  1: "step2",
  2: "update",
};

function syncFrameSummary(
  documentName: string,
  innerSyncType: InnerSyncType,
  payloadBytes: number,
): SyncFrameSummary {
  const base = { documentName, payloadBytes };
  switch (innerSyncType) {
    case "step1":
      return { ...base, messageClass: "sync.step1", innerSyncType };
    case "step2":
      return { ...base, messageClass: "sync.step2", innerSyncType };
    case "update":
      return { ...base, messageClass: "sync.update", innerSyncType };
  }
}

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
  if (bytes.byteLength === 1 && bytes[0] === OUTER_PING) {
    return {
      summary: { documentName: null, messageClass: "ping", payloadBytes: 0 },
    };
  }
  if (bytes.byteLength === 1 && bytes[0] === OUTER_PONG) {
    return {
      summary: { documentName: null, messageClass: "pong", payloadBytes: 0 },
    };
  }

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
        summary: syncFrameSummary(documentName, innerSyncType, payload.byteLength),
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
      const authType = readVarUint(decoder);
      if (!Number.isSafeInteger(authType)) return { summary: unknown(bytes, documentName) };
      return {
        summary: {
          documentName,
          messageClass: "auth",
          payloadBytes: bytes.byteLength - payloadStart,
        },
      };
    }

    if (outerType === OUTER_CLOSE) {
      if (decoder.pos === bytes.byteLength) {
        return { summary: { documentName, messageClass: "close", payloadBytes: 0 } };
      }

      // A lib0 string and byte array share the same length-prefixed envelope.
      // Count the reason without materializing its content.
      const reason = readVarUint8Array(decoder);
      if (decoder.pos !== bytes.byteLength) return { summary: unknown(bytes, documentName) };
      return {
        summary: { documentName, messageClass: "close", payloadBytes: reason.byteLength },
      };
    }

    if (outerType === OUTER_SYNC_STATUS) {
      const payloadStart = decoder.pos;
      const applied = readVarInt(decoder) === 1;
      if (decoder.pos !== bytes.byteLength) return { summary: unknown(bytes, documentName) };
      return {
        summary: {
          documentName,
          messageClass: "sync.status",
          applied,
          payloadBytes: decoder.pos - payloadStart,
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

  if (
    decoded.summary.messageClass === "sync.step2" ||
    decoded.summary.messageClass === "sync.update"
  ) {
    if (!decoded.payload) return { frame: decoded.summary };
    const update = summarizeUpdate(decoded.payload);
    return "invalid" in update ? { frame: decoded.summary } : { frame: decoded.summary, update };
  }

  if (decoded.summary.messageClass === "awareness") {
    if (decoded.queryAwareness) {
      return { frame: decoded.summary, awareness: emptyAwarenessSummary() };
    }
    if (decoded.payload) {
      try {
        return { frame: decoded.summary, awareness: summarizeAwareness(decoded.payload) };
      } catch {
        // A valid outer envelope can still contain a malformed awareness
        // payload. Preserve its classification and omit only its summary.
      }
    }
    return { frame: decoded.summary };
  }

  return { frame: decoded.summary };
}

function emptyAwarenessSummary(): AwarenessSummary {
  return { clients: [], count: 0, removedCount: 0, bytes: 0 };
}
