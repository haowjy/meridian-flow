/**
 * Content-safe copies of representative frames captured from the live Yjs socket.
 *
 * Provenance:
 * - Captured 2026-07-16 with Chrome DevTools Protocol Network.webSocketFrame events.
 * - Producers: @hocuspocus/provider@4.3.0, yjs@13.6.31, lib0@0.2.117.
 * - Source: $MERIDIAN_ACTIVE_WORK_DIR/reports/cdp-ws-frames.jsonl.
 * - The SyncStatus bytes were first captured 2026-07-16 in the CDP source above
 *   and re-observed byte-identically with @hocuspocus/provider@4.3.0 by the
 *   2026-07-17 S3 tap-seam probe. Drift confirmation source:
 *   $MERIDIAN_ACTIVE_WORK_DIR/reports/s3-phase5-unknown-outer-type.json.
 *
 * That capture contains sync-update and awareness frames, but no sync-step-1,
 * sync-step-2, stateless, auth, query-awareness, close, ping, or pong frames.
 * Those paths remain explicitly synthesized in inspect.test.ts; none are
 * labeled captured.
 */

import type { FrameSummary } from "../types.js";

export interface CapturedFrameFixture {
  direction: "sent" | "received";
  encoding: "base64" | "utf8";
  payloadData: string;
  expected: FrameSummary;
}

const documentName = "2e825ae4-6d05-4620-960a-51b6020e05bc";

export const capturedFrames: CapturedFrameFixture[] = [
  {
    direction: "sent",
    encoding: "base64",
    payloadData: "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwACEgEBjqa50AsBhI6mudALAAE/AA==",
    expected: {
      documentName,
      messageClass: "sync.update",
      innerSyncType: "update",
      payloadBytes: 18,
    },
  },
  {
    direction: "sent",
    encoding: "base64",
    payloadData:
      "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwGtAgGOprnQCwukAnsidXNlciI6eyJuYW1lIjoiTWVyaWRpYW4gUmVzZWFyY2hlciIsImNvbG9yIjoiIzYxYWZlZiJ9LCJjdXJzb3IiOnsiYW5jaG9yIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9LCJoZWFkIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9fX0=",
    expected: { documentName, messageClass: "awareness", payloadBytes: 301 },
  },
  {
    direction: "received",
    encoding: "base64",
    payloadData: "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwACEgEBjqa50AsBhI6mudALAAE/AA==",
    expected: {
      documentName,
      messageClass: "sync.update",
      innerSyncType: "update",
      payloadBytes: 18,
    },
  },
  {
    direction: "received",
    encoding: "base64",
    payloadData: "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwgB",
    expected: { documentName, messageClass: "sync.status", applied: true, payloadBytes: 1 },
  },
  {
    direction: "received",
    encoding: "base64",
    payloadData:
      "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwGtAgGOprnQCwukAnsidXNlciI6eyJuYW1lIjoiTWVyaWRpYW4gUmVzZWFyY2hlciIsImNvbG9yIjoiIzYxYWZlZiJ9LCJjdXJzb3IiOnsiYW5jaG9yIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9LCJoZWFkIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9fX0=",
    expected: { documentName, messageClass: "awareness", payloadBytes: 301 },
  },
  {
    direction: "sent",
    encoding: "utf8",
    payloadData: '{"type":"ping"}',
    expected: { documentName: null, messageClass: "unknown", payloadBytes: 15 },
  },
  {
    direction: "received",
    encoding: "utf8",
    payloadData: '{"type":"ping","ts":1784257962127}',
    expected: { documentName: null, messageClass: "unknown", payloadBytes: 34 },
  },
  {
    direction: "sent",
    encoding: "utf8",
    payloadData: '{"type":"pong"}',
    expected: { documentName: null, messageClass: "unknown", payloadBytes: 15 },
  },
];

export const capturedJournalUpdateHex =
  "0103d787ee990a0007010b70726f73656d6972726f7203097061726167726170680700d787ee990a00060400d787ee990a01014100";
