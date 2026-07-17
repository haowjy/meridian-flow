/** Verifies protocol classification, update correlation, and content safety. */

import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { describe, expect, it } from "vitest";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { capturedFrames, capturedJournalUpdateHex } from "./__fixtures__/captured.js";
import { classifyFrame, summarizeAwareness, summarizeUpdate } from "./index.js";

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function frame(documentName: string, outerType: number, payload?: Uint8Array): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, outerType);
  if (payload) writeVarUint8Array(encoder, payload);
  return toUint8Array(encoder);
}

function syncFrame(documentName: string, innerType: number, payload: Uint8Array): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, 0);
  writeVarUint(encoder, innerType);
  writeVarUint8Array(encoder, payload);
  return toUint8Array(encoder);
}

describe("classifyFrame", () => {
  it("pins the captured Hocuspocus envelope in both directions", () => {
    for (const fixture of capturedFrames) {
      expect(classifyFrame(fromBase64(fixture.base64)), fixture.direction).toEqual(
        fixture.expected,
      );
    }
  });

  it("classifies every supported transport message class", () => {
    expect(classifyFrame(syncFrame("doc", 0, new Uint8Array([0]))).messageClass).toBe("sync.step1");
    expect(classifyFrame(syncFrame("doc", 1, new Uint8Array([0]))).messageClass).toBe("sync.step2");
    expect(classifyFrame(syncFrame("doc", 2, new Uint8Array([0, 0]))).messageClass).toBe(
      "sync.update",
    );
    expect(classifyFrame(frame("doc", 1, new Uint8Array([0]))).messageClass).toBe("awareness");
    expect(classifyFrame(frame("doc", 3)).messageClass).toBe("awareness");
    expect(classifyFrame(frame("doc", 5, new Uint8Array([1, 2, 3]))).messageClass).toBe(
      "stateless",
    );

    const auth = createEncoder();
    writeVarString(auth, "doc");
    writeVarUint(auth, 2);
    writeVarUint(auth, 0);
    expect(classifyFrame(toUint8Array(auth)).messageClass).toBe("auth");
  });

  it("returns explicit unknown metadata for unsupported and malformed frames", () => {
    expect(classifyFrame(new Uint8Array([0xff]))).toEqual({
      documentName: null,
      messageClass: "unknown",
      payloadBytes: 1,
    });
    expect(classifyFrame(frame("doc", 8, new Uint8Array([1])))).toEqual({
      documentName: "doc",
      messageClass: "unknown",
      payloadBytes: 7,
    });
  });
});

describe("summarizeUpdate", () => {
  it("pins metadata and hash for a captured journal row", () => {
    expect(summarizeUpdate(fromHex(capturedJournalUpdateHex))).toEqual({
      clients: [{ client: 2738586583, clockFrom: 0, clockTo: 3 }],
      structCount: 3,
      deleteSetSize: 0,
      isNoop: false,
      bytes: 53,
      updateHash: "94b2888e27b6dc01",
    });
  });

  it("identifies the canonical empty update", () => {
    expect(summarizeUpdate(new Uint8Array([0, 0]))).toMatchObject({
      clients: [],
      structCount: 0,
      deleteSetSize: 0,
      isNoop: true,
      bytes: 2,
    });
  });

  it("counts clocks in delete sets", () => {
    const document = new Y.Doc();
    const text = document.getText("content");
    text.insert(0, "abc");
    const beforeDelete = Y.encodeStateVector(document);
    text.delete(1, 1);

    expect(summarizeUpdate(Y.encodeStateAsUpdate(document, beforeDelete))).toMatchObject({
      clients: [],
      structCount: 0,
      deleteSetSize: 1,
      isNoop: false,
    });
  });
});

describe("summarizeAwareness", () => {
  it("returns client clocks and self-evident removals without state", () => {
    const encoder = createEncoder();
    writeVarUint(encoder, 2);
    writeVarUint(encoder, 41);
    writeVarUint(encoder, 7);
    writeVarString(encoder, '{"name":"hidden"}');
    writeVarUint(encoder, 42);
    writeVarUint(encoder, 8);
    writeVarString(encoder, "null");
    const payload = toUint8Array(encoder);

    expect(summarizeAwareness(payload)).toEqual({
      clients: [
        { client: 41, clock: 7, removed: false },
        { client: 42, clock: 8, removed: true },
      ],
      count: 2,
      removedCount: 1,
      bytes: payload.byteLength,
    });
  });
});

it("never returns document, attribute, or awareness state content from any exported function", async () => {
  const canary = "XCONTENT_LEAK_CANARYX";
  const document = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("data-secret", canary);
  const text = new Y.XmlText();
  text.insert(0, canary);
  paragraph.insert(0, [text]);
  document.getXmlFragment("content").insert(0, [paragraph]);
  const update = Y.encodeStateAsUpdate(document);

  const awareness = new Awareness(document);
  awareness.setLocalState({ secret: canary });
  const awarenessPayload = encodeAwarenessUpdate(awareness, [document.clientID]);

  const inspector = await import("./index.js");
  const invocations: Record<string, () => unknown> = {
    classifyFrame: () => classifyFrame(syncFrame("safe-room", 2, update)),
    summarizeAwareness: () => summarizeAwareness(awarenessPayload),
    summarizeUpdate: () => summarizeUpdate(update),
  };
  const exportedFunctions = Object.entries(inspector).filter(
    ([, value]) => typeof value === "function",
  );

  expect(exportedFunctions.map(([name]) => name).sort()).toEqual(Object.keys(invocations).sort());
  for (const [name] of exportedFunctions) {
    const result = invocations[name]?.();
    expect(result, `${name} was not exercised`).toBeDefined();
    expect(JSON.stringify(result), name).not.toContain(canary);
  }
});
