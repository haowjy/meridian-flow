/** Content-safe copies of representative frames captured from the live Yjs socket. */

import type { FrameSummary } from "../types.js";

export interface CapturedFrameFixture {
  direction: "sent" | "received";
  base64: string;
  expected: FrameSummary;
}

const documentName = "2e825ae4-6d05-4620-960a-51b6020e05bc";

export const capturedFrames: CapturedFrameFixture[] = [
  {
    direction: "sent",
    base64: "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwACEgEBjqa50AsBhI6mudALAAE/AA==",
    expected: {
      documentName,
      messageClass: "sync.update",
      innerSyncType: "update",
      payloadBytes: 18,
    },
  },
  {
    direction: "received",
    base64: "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwACEgEBjqa50AsBhI6mudALAAE/AA==",
    expected: {
      documentName,
      messageClass: "sync.update",
      innerSyncType: "update",
      payloadBytes: 18,
    },
  },
  {
    direction: "sent",
    base64:
      "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwGtAgGOprnQCwukAnsidXNlciI6eyJuYW1lIjoiTWVyaWRpYW4gUmVzZWFyY2hlciIsImNvbG9yIjoiIzYxYWZlZiJ9LCJjdXJzb3IiOnsiYW5jaG9yIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9LCJoZWFkIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9fX0=",
    expected: { documentName, messageClass: "awareness", payloadBytes: 301 },
  },
  {
    direction: "received",
    base64:
      "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwGtAgGOprnQCwukAnsidXNlciI6eyJuYW1lIjoiTWVyaWRpYW4gUmVzZWFyY2hlciIsImNvbG9yIjoiIzYxYWZlZiJ9LCJjdXJzb3IiOnsiYW5jaG9yIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9LCJoZWFkIjp7InR5cGUiOnsiY2xpZW50IjoyNzM4NTg2NTgzLCJjbG9jayI6MX0sInRuYW1lIjpudWxsLCJpdGVtIjp7ImNsaWVudCI6MzEyMTUwMDk0MiwiY2xvY2siOjF9LCJhc3NvYyI6LTF9fX0=",
    expected: { documentName, messageClass: "awareness", payloadBytes: 301 },
  },
  {
    direction: "received",
    base64: "JDJlODI1YWU0LTZkMDUtNDYyMC05NjBhLTUxYjYwMjBlMDViYwgB",
    expected: { documentName, messageClass: "unknown", payloadBytes: 39 },
  },
];

export const capturedJournalUpdateHex =
  "0103d787ee990a0007010b70726f73656d6972726f7203097061726167726170680700d787ee990a00060400d787ee990a01014100";
