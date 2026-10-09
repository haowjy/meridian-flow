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
import { classifyFrame, inspectFrame, summarizeUpdate } from "./index.js";

const textEncoder = new TextEncoder();

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

function authFrame(body: Uint8Array): Uint8Array {
  return new Uint8Array([...frame("doc", 2), ...body]);
}

function controlFrame(
  documentName: string,
  outerType: number,
  body = new Uint8Array(),
): Uint8Array {
  return new Uint8Array([...frame(documentName, outerType), ...body]);
}

function assertSafeEgress(
  value: unknown,
  canary: string,
  path = "$",
  seen = new Set<object>(),
): void {
  if (typeof value === "string") {
    if (value.includes(canary)) throw new Error(`${path} contains the content canary`);
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value !== "object") {
    throw new Error(`${path} contains non-JSON-natural ${typeof value}`);
  }
  if (seen.has(value)) throw new Error(`${path} contains a non-JSON-natural cycle`);
  seen.add(value);

  if (ArrayBuffer.isView(value)) {
    throw new Error(`${path} contains a non-JSON-natural ArrayBuffer view`);
  }
  if (value instanceof ArrayBuffer) {
    throw new Error(`${path} contains a non-JSON-natural ArrayBuffer`);
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      assertSafeEgress(key, canary, `${path}.<map-key>`, seen);
      assertSafeEgress(entry, canary, `${path}.<map-value>`, seen);
    }
    throw new Error(`${path} contains a non-JSON-natural Map`);
  }
  if (value instanceof Set) {
    for (const entry of value) assertSafeEgress(entry, canary, `${path}.<set-value>`, seen);
    throw new Error(`${path} contains a non-JSON-natural Set`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertSafeEgress(entry, canary, `${path}[${index}]`, seen);
    });
    seen.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${path} contains a non-JSON-natural object prototype`);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new Error(`${path} contains a non-JSON-natural symbol key`);
    }
    if (key.includes(canary)) throw new Error(`${path} contains the content canary in a key`);
    assertSafeEgress(Reflect.get(value, key), canary, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

describe("inspectFrame", () => {
  it("never throws when a classified frame contains a malformed nested payload", () => {
    expect(inspectFrame(syncFrame("doc", 2, new Uint8Array([0xff])))).toEqual({
      frame: {
        documentName: "doc",
        messageClass: "sync.update",
        innerSyncType: "update",
        payloadBytes: 1,
      },
    });
    expect(inspectFrame(frame("doc", 1, new Uint8Array([0xff])))).toEqual({
      frame: { documentName: "doc", messageClass: "awareness", payloadBytes: 1 },
    });
  });
});

describe("summarizeUpdate", () => {
  it("returns identifiable invalid metadata for malformed updates without throwing", () => {
    for (const update of [new Uint8Array(), new Uint8Array([0xff]), new Uint8Array([1])]) {
      expect(summarizeUpdate(update)).toMatchObject({
        invalid: true,
        reason: expect.any(String),
        bytes: update.byteLength,
        updateHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
    }
  });
});

it("never throws for seeded arbitrary byte blobs", () => {
  let seed = 0x6d657269;
  const randomUint32 = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const messageClasses = [
    "sync.step1",
    "sync.step2",
    "sync.update",
    "awareness",
    "stateless",
    "auth",
    "sync.status",
    "close",
    "ping",
    "pong",
    "unknown",
  ];

  for (let sample = 0; sample < 300; sample += 1) {
    const bytes = Uint8Array.from({ length: randomUint32() % 65 }, () => randomUint32() & 0xff);
    const summary = classifyFrame(bytes);
    const inspection = inspectFrame(bytes);

    expect(inspection.frame).toEqual(summary);
    expect(messageClasses).toContain(summary.messageClass);
    expect(Number.isSafeInteger(summary.payloadBytes)).toBe(true);
    expect(summary.payloadBytes).toBeGreaterThanOrEqual(0);
    expect(summary.payloadBytes).toBeLessThanOrEqual(bytes.byteLength);
  }
});

it("never returns content from any exported function across every frame path", async () => {
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

  const auth = createEncoder();
  writeVarUint(auth, 0);
  writeVarString(auth, canary);

  const truncated = createEncoder();
  writeVarString(truncated, "safe-room");
  writeVarUint(truncated, 5);
  writeVarUint(truncated, textEncoder.encode(canary).byteLength + 1);
  const canaryBearingTruncatedFrame = new Uint8Array([
    ...toUint8Array(truncated),
    ...textEncoder.encode(canary),
  ]);

  const framePaths: Array<{ name: string; bytes: Uint8Array }> = [
    {
      name: "sync.step1",
      bytes: syncFrame("safe-room", 0, Y.encodeStateVector(document)),
    },
    { name: "sync.step2", bytes: syncFrame("safe-room", 1, update) },
    { name: "sync.update", bytes: syncFrame("safe-room", 2, update) },
    { name: "awareness", bytes: frame("safe-room", 1, awarenessPayload) },
    { name: "query-awareness", bytes: frame("safe-room", 3) },
    { name: "stateless", bytes: frame("safe-room", 5, textEncoder.encode(canary)) },
    { name: "auth", bytes: authFrame(toUint8Array(auth)) },
    {
      name: "close",
      bytes: frame("safe-room", 7, textEncoder.encode(canary)),
    },
    { name: "sync.status.applied", bytes: controlFrame("safe-room", 8, new Uint8Array([1])) },
    {
      name: "sync.status.not-applied",
      bytes: controlFrame("safe-room", 8, new Uint8Array([0])),
    },
    { name: "ping", bytes: new Uint8Array([9]) },
    { name: "pong", bytes: new Uint8Array([10]) },
    { name: "unknown", bytes: frame("safe-room", 11, textEncoder.encode(canary)) },
    { name: "truncated", bytes: canaryBearingTruncatedFrame },
  ];

  const inspector = await import("./index.js");
  const invocations: Record<string, () => void> = {
    classifyFrame: () => {
      for (const path of framePaths) {
        assertSafeEgress(classifyFrame(path.bytes), canary, `classifyFrame/${path.name}`);
      }
    },
    inspectFrame: () => {
      for (const path of framePaths) {
        assertSafeEgress(inspectFrame(path.bytes), canary, `inspectFrame/${path.name}`);
      }
    },
    summarizeUpdate: () => {
      assertSafeEgress(summarizeUpdate(update), canary, "summarizeUpdate/valid");
      const invalidUpdate = summarizeUpdate(new Uint8Array([0xff]));
      expect(invalidUpdate).toMatchObject({ invalid: true });
      assertSafeEgress(invalidUpdate, canary, "summarizeUpdate/invalid");
    },
  };
  const exportedFunctions = Object.entries(inspector).filter(
    ([, value]) => typeof value === "function",
  );

  expect(exportedFunctions.map(([name]) => name).sort()).toEqual(Object.keys(invocations).sort());
  for (const [name] of exportedFunctions) {
    const invoke = invocations[name];
    expect(invoke, `${name} is missing from the egress gate`).toBeTypeOf("function");
    invoke?.();
  }
});
