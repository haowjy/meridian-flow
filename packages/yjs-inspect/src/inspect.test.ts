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
  it("composes nested update and awareness metadata from complete frames", () => {
    const document = new Y.Doc();
    document.getText("content").insert(0, "hidden");
    const update = Y.encodeStateAsUpdate(document);
    const stateVector = Y.encodeStateVector(document);

    expect(inspectFrame(syncFrame("doc", 0, stateVector))).not.toHaveProperty("update");
    expect(inspectFrame(syncFrame("doc", 1, update)).update?.structCount).toBe(1);
    expect(inspectFrame(syncFrame("doc", 2, update)).update?.structCount).toBe(1);

    const awareness = new Awareness(document);
    awareness.setLocalState({ hidden: true });
    const payload = encodeAwarenessUpdate(awareness, [document.clientID]);
    expect(inspectFrame(frame("doc", 1, payload)).awareness).toMatchObject({
      count: 1,
      removedCount: 0,
    });
    expect(inspectFrame(frame("doc", 3)).awareness).toEqual({
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

  it("keeps merged spans overlap-valid and coalesces adjacent delete ranges", () => {
    const document = new Y.Doc();
    const text = document.getText("content");
    const updates: Uint8Array[] = [];
    document.on("update", (update) => updates.push(update));
    text.insert(0, "a");
    text.insert(1, "b");

    const insertA = summarizeUpdate(updates[0]);
    const insertB = summarizeUpdate(updates[1]);
    const mergedInserts = summarizeUpdate(Y.mergeUpdates(updates.slice(0, 2)));
    expect(overlaps(mergedInserts.structSpans, insertA.structSpans)).toBe(true);
    expect(overlaps(mergedInserts.structSpans, insertB.structSpans)).toBe(true);

    text.delete(0, 1);
    text.delete(0, 1);
    const deleteA = summarizeUpdate(updates[2]);
    const deleteB = summarizeUpdate(updates[3]);
    const mergedDeletes = summarizeUpdate(Y.mergeUpdates(updates.slice(2)));
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
    const validSummary = summarizeUpdate(valid);
    const junkSummary = summarizeUpdate(withJunk);

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
  it("exits nonzero and names every unrecognized row id", () => {
    const result = spawnSync("pnpm", ["tsx", "examples/decode-journal.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      input: "1 0000\n42 not-an-update\n2 0000\ngarbage\n",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unrecognized input row ids: 42 (line 2), line 4");
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

    expect(inspectFrame(frame("doc", 1, payload)).awareness).toEqual({
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
  const noOp = new Uint8Array([0, 0]);

  const auth = createEncoder();
  writeVarUint(auth, 0);
  writeVarString(auth, canary);

  const framePaths: Array<{ name: string; bytes: Uint8Array; update: Uint8Array }> = [
    {
      name: "sync.step1",
      bytes: syncFrame("safe-room", 0, Y.encodeStateVector(document)),
      update: noOp,
    },
    { name: "sync.step2", bytes: syncFrame("safe-room", 1, update), update },
    { name: "sync.update", bytes: syncFrame("safe-room", 2, update), update },
    { name: "awareness", bytes: frame("safe-room", 1, awarenessPayload), update: noOp },
    { name: "stateless", bytes: frame("safe-room", 5, textEncoder.encode(canary)), update: noOp },
    { name: "auth", bytes: authFrame(toUint8Array(auth)), update: noOp },
    { name: "unknown", bytes: frame("safe-room", 8, textEncoder.encode(canary)), update: noOp },
    { name: "truncated", bytes: new Uint8Array([0xff]), update: noOp },
  ];

  const inspector = await import("./index.js");
  const invocations: Record<string, (path: (typeof framePaths)[number]) => unknown> = {
    classifyFrame: (path) => classifyFrame(path.bytes),
    inspectFrame: (path) => inspectFrame(path.bytes),
    summarizeUpdate: (path) => summarizeUpdate(path.update),
  };
  const exportedFunctions = Object.entries(inspector).filter(
    ([, value]) => typeof value === "function",
  );

  expect(exportedFunctions.map(([name]) => name).sort()).toEqual(Object.keys(invocations).sort());
  for (const [name] of exportedFunctions) {
    for (const path of framePaths) {
      const result = invocations[name]?.(path);
      expect(result, `${name} was not exercised for ${path.name}`).toBeDefined();
      expect(JSON.stringify(result), `${name} leaked content for ${path.name}`).not.toContain(
        canary,
      );
    }
  }
});
