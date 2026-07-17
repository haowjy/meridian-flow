/** Verifies protocol classification, update correlation, and content safety. */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import { classifyFrame, inspectFrame, summarizeUpdate } from "./index.js";
import type {
  AuthFrameSummary,
  AwarenessSummary,
  FrameInspection,
  SyncUpdateFrameSummary,
  UpdateSummary,
} from "./types.js";

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

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

function summarizeValidUpdate(update: Uint8Array): UpdateSummary {
  const summary = summarizeUpdate(update);
  if ("invalid" in summary) throw new Error("Expected a valid Yjs update fixture");
  return summary;
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

describe("classifyFrame", () => {
  it("pins the captured Hocuspocus envelope in both directions", () => {
    expect(capturedFrames).toHaveLength(8);
    for (const fixture of capturedFrames) {
      const bytes =
        fixture.encoding === "base64"
          ? fromBase64(fixture.payloadData)
          : textEncoder.encode(fixture.payloadData);
      expect(classifyFrame(bytes), fixture.direction).toEqual(fixture.expected);
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

    expect(classifyFrame(authFrame(new Uint8Array([0]))).messageClass).toBe("auth");
  });

  it("rejects auth frames with a truncated or invalid varuint body", () => {
    expect(classifyFrame(authFrame(new Uint8Array())).messageClass).toBe("unknown");
    expect(classifyFrame(authFrame(new Uint8Array([0x80]))).messageClass).toBe("unknown");
    expect(classifyFrame(authFrame(new Uint8Array(9).fill(0xff))).messageClass).toBe("unknown");
    expect(
      classifyFrame(authFrame(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])))
        .messageClass,
    ).toBe("unknown");
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

describe("inspectFrame", () => {
  it("excludes cross-class nested summaries from the public type", () => {
    type AuthWithUpdate = { frame: AuthFrameSummary; update: UpdateSummary };
    type SyncWithAwareness = { frame: SyncUpdateFrameSummary; awareness: AwarenessSummary };
    const authWithUpdateIsAssignable: AuthWithUpdate extends FrameInspection ? true : false = false;
    const syncWithAwarenessIsAssignable: SyncWithAwareness extends FrameInspection ? true : false =
      false;

    expect([authWithUpdateIsAssignable, syncWithAwarenessIsAssignable]).toEqual([false, false]);
  });

  it("composes nested update and awareness metadata from complete frames", () => {
    const document = new Y.Doc();
    document.getText("content").insert(0, "hidden");
    const update = Y.encodeStateAsUpdate(document);
    const stateVector = Y.encodeStateVector(document);

    expect(inspectFrame(syncFrame("doc", 0, stateVector))).not.toHaveProperty("update");
    const step2 = inspectFrame(syncFrame("doc", 1, update));
    const syncUpdate = inspectFrame(syncFrame("doc", 2, update));
    expect("update" in step2 && step2.update?.structCount).toBe(1);
    expect("update" in syncUpdate && syncUpdate.update?.structCount).toBe(1);

    const awareness = new Awareness(document);
    awareness.setLocalState({ hidden: true });
    const payload = encodeAwarenessUpdate(awareness, [document.clientID]);
    const awarenessInspection = inspectFrame(frame("doc", 1, payload));
    expect("awareness" in awarenessInspection && awarenessInspection.awareness).toMatchObject({
      count: 1,
      removedCount: 0,
    });
    const awarenessQuery = inspectFrame(frame("doc", 3));
    expect("awareness" in awarenessQuery && awarenessQuery.awareness).toEqual({
      clients: [],
      count: 0,
      removedCount: 0,
      bytes: 0,
    });
  });

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

  it("pins metadata and hash for a captured journal row", () => {
    expect(summarizeUpdate(fromHex(capturedJournalUpdateHex))).toEqual({
      structSpans: [{ client: 2738586583, clockFrom: 0, clockTo: 3 }],
      deleteSpans: [],
      spansKey: "s:2738586583:0-3",
      structCount: 3,
      deleteRangeCount: 0,
      deletedLength: 0,
      isNoop: false,
      bytes: 53,
      updateHash: "94b2888e27b6dc01",
    });
  });

  it("pins insert-bearing, deletion-only, and no-op correlation keys", () => {
    const insert20 = new Y.Doc();
    insert20.clientID = 20;
    insert20.getText("content").insert(0, "ab");
    const insert20Update = Y.encodeStateAsUpdate(insert20);

    const insert10 = new Y.Doc();
    insert10.clientID = 10;
    insert10.getText("content").insert(0, "x");
    const insert10Update = Y.encodeStateAsUpdate(insert10);

    const beforeDelete = Y.encodeStateVector(insert20);
    insert20.getText("content").delete(0, 1);
    const deletionOnly = Y.encodeStateAsUpdate(insert20, beforeDelete);
    const insertBearing = summarizeUpdate(
      Y.mergeUpdates([insert20Update, insert10Update, deletionOnly]),
    );

    expect(insertBearing).toMatchObject({
      structSpans: [
        { client: 10, clockFrom: 0, clockTo: 1 },
        { client: 20, clockFrom: 0, clockTo: 2 },
      ],
      deleteSpans: [{ client: 20, clockFrom: 0, clockTo: 1 }],
      spansKey: "s:10:0-1,s:20:0-2,d:20:0-1",
      structCount: 2,
      deleteRangeCount: 1,
      deletedLength: 1,
      isNoop: false,
    });
    expect(summarizeUpdate(deletionOnly)).toMatchObject({
      structSpans: [],
      deleteSpans: [{ client: 20, clockFrom: 0, clockTo: 1 }],
      spansKey: "d:20:0-1",
      structCount: 0,
      deleteRangeCount: 1,
      deletedLength: 1,
      isNoop: false,
    });
    expect(summarizeUpdate(new Uint8Array([0, 0]))).toMatchObject({
      structSpans: [],
      deleteSpans: [],
      spansKey: "",
      structCount: 0,
      deleteRangeCount: 0,
      deletedLength: 0,
      isNoop: true,
      bytes: 2,
    });
  });

  it("keys cross-client deletions by the deleted content creator", () => {
    const creator = new Y.Doc();
    creator.clientID = 739274145;
    creator.getText("content").insert(0, "hello");

    const deleter = new Y.Doc();
    deleter.clientID = 42;
    Y.applyUpdate(deleter, Y.encodeStateAsUpdate(creator));
    const deletionUpdates: Uint8Array[] = [];
    deleter.on("update", (update) => {
      deletionUpdates.push(update);
    });
    deleter.getText("content").delete(1, 2);

    expect(summarizeValidUpdate(deletionUpdates[0])).toMatchObject({
      structSpans: [],
      deleteSpans: [{ client: creator.clientID, clockFrom: 1, clockTo: 3 }],
      spansKey: `d:${creator.clientID}:1-3`,
      structCount: 0,
    });
  });

  it("keeps merged spans overlap-valid and coalesces adjacent delete ranges", () => {
    const document = new Y.Doc();
    const text = document.getText("content");
    const updates: Uint8Array[] = [];
    document.on("update", (update) => updates.push(update));
    text.insert(0, "a");
    text.insert(1, "b");

    const insertA = summarizeValidUpdate(updates[0]);
    const insertB = summarizeValidUpdate(updates[1]);
    const mergedInserts = summarizeValidUpdate(Y.mergeUpdates(updates.slice(0, 2)));
    expect(overlaps(mergedInserts.structSpans, insertA.structSpans)).toBe(true);
    expect(overlaps(mergedInserts.structSpans, insertB.structSpans)).toBe(true);

    text.delete(0, 1);
    text.delete(0, 1);
    const deleteA = summarizeValidUpdate(updates[2]);
    const deleteB = summarizeValidUpdate(updates[3]);
    const mergedDeletes = summarizeValidUpdate(Y.mergeUpdates(updates.slice(2)));
    expect(deleteA.deleteSpans[0]).toMatchObject({ clockFrom: 0, clockTo: 1 });
    expect(deleteB.deleteSpans[0]).toMatchObject({ clockFrom: 1, clockTo: 2 });
    expect(mergedDeletes.deleteSpans).toEqual([
      { client: document.clientID, clockFrom: 0, clockTo: 2 },
    ]);
    expect(overlaps(mergedDeletes.deleteSpans, deleteA.deleteSpans)).toBe(true);
    expect(overlaps(mergedDeletes.deleteSpans, deleteB.deleteSpans)).toBe(true);
  });

  it("excludes Skip structs and splits spans at clock discontinuities", () => {
    const document = new Y.Doc();
    const updates: Uint8Array[] = [];
    document.on("update", (update) => updates.push(update));
    document.getText("content").insert(0, "a");
    document.getText("content").insert(1, "b");
    document.getText("content").insert(2, "c");

    expect(summarizeUpdate(Y.mergeUpdates([updates[0], updates[2]]))).toMatchObject({
      structSpans: [
        { client: document.clientID, clockFrom: 0, clockTo: 1 },
        { client: document.clientID, clockFrom: 2, clockTo: 3 },
      ],
      structCount: 2,
    });
  });

  it("covers full trailing-byte input in bytes and hash but not spans", () => {
    const valid = fromHex(capturedJournalUpdateHex);
    const withJunk = new Uint8Array([...valid, 0xde, 0xad]);
    const validSummary = summarizeValidUpdate(valid);
    const junkSummary = summarizeValidUpdate(withJunk);

    expect(junkSummary.structSpans).toEqual(validSummary.structSpans);
    expect(junkSummary.deleteSpans).toEqual(validSummary.deleteSpans);
    expect(junkSummary.spansKey).toBe(validSummary.spansKey);
    expect(junkSummary.bytes).toBe(validSummary.bytes + 2);
    expect(junkSummary.updateHash).not.toBe(validSummary.updateHash);
  });
});

function overlaps(
  left: Array<{ client: number; clockFrom: number; clockTo: number }>,
  right: Array<{ client: number; clockFrom: number; clockTo: number }>,
): boolean {
  return left.some((leftSpan) =>
    right.some(
      (rightSpan) =>
        leftSpan.client === rightSpan.client &&
        leftSpan.clockFrom < rightSpan.clockTo &&
        rightSpan.clockFrom < leftSpan.clockTo,
    ),
  );
}

describe("decode-journal CLI", () => {
  it.each([
    {
      name: "rejects expanded records with no recognized update payload",
      input: "-[ RECORD 1 ]---\nid | 1\nupdate_hex | 0000\n-[ RECORD 42 ]---\nbogus | arbitrary\n",
      expectedStderr: "42",
    },
    {
      name: "names every expanded record whose update hex has invalid shape",
      input:
        "-[ RECORD 1 ]---\nid | journal-99\nupdate_hex | f\n-[ RECORD 42 ]---\nupdate_hex | abc\n",
      expectedStderr: "Unrecognized input row ids: journal-99, 42",
    },
    {
      name: "names every unrecognized row id",
      input: "1 0000\n42 not-an-update\n2 0000\ngarbage\nnonsense | arbitrary\n",
      expectedStderr: "Unrecognized input row ids: 42 (line 2), line 4, line 5",
    },
    {
      name: "names invalid update bytes before emitting output",
      input: "1 0000\n88 ff\n",
      expectedStderr: "Invalid Yjs update in row 88",
    },
  ])("$name", ({ input, expectedStderr }) => {
    const result = spawnSync("pnpm", ["tsx", "examples/decode-journal.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      input,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedStderr);
    expect(result.stdout).toBe("");
  });
});

describe("awareness summaries", () => {
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

    const inspection = inspectFrame(frame("doc", 1, payload));
    expect("awareness" in inspection && inspection.awareness).toEqual({
      clients: [
        { client: 41, clock: 7, removed: false },
        { client: 42, clock: 8, removed: true },
      ],
      count: 2,
      removedCount: 1,
      bytes: payload.byteLength,
    });
  });

  it("omits nested metadata when a valid awareness update has trailing bytes", () => {
    const encoder = createEncoder();
    writeVarUint(encoder, 1);
    writeVarUint(encoder, 41);
    writeVarUint(encoder, 7);
    writeVarString(encoder, "null");
    writeVarUint(encoder, 99);
    const payload = toUint8Array(encoder);

    expect(inspectFrame(frame("doc", 1, payload))).toEqual({
      frame: { documentName: "doc", messageClass: "awareness", payloadBytes: payload.byteLength },
    });
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
    { name: "unknown", bytes: frame("safe-room", 8, textEncoder.encode(canary)) },
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

it("rejects content and non-JSON-natural shapes from the egress gate", () => {
  const canary = "XCONTENT_LEAK_CANARYX";
  expect(() => assertSafeEgress({ nested: [{ value: canary }] }, canary)).toThrow(
    "contains the content canary",
  );
  expect(() => assertSafeEgress({ [canary]: 1 }, canary)).toThrow("contains the content canary");

  const violations: unknown[] = [
    new Uint8Array(),
    new ArrayBuffer(0),
    new DataView(new ArrayBuffer(0)),
    new Map(),
    new Set(),
    () => undefined,
    Symbol("egress"),
  ];
  for (const violation of violations) {
    expect(() => assertSafeEgress({ violation }, canary)).toThrow("non-JSON-natural");
  }
});
