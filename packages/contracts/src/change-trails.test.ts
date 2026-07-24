import { describe, expect, it } from "vitest";
import { parseTrailChangesV1, type TrailChangeV1 } from "./change-trails.js";

function validChange(): TrailChangeV1 {
  return {
    changeId: "change-1",
    ordinal: 0,
    documentId: "document-1",
    pushId: "push-1",
    receiptId: "receipt-1",
    kind: "modify",
    beforeBlockId: null,
    afterBlockId: null,
    beforeBlockIdentity: { documentId: "document-1", clientID: 7, clock: 11 },
    afterBlockIdentity: { documentId: "document-1", clientID: 7, clock: 11 },
    beforeText: "before",
    afterTextAtReceipt: "after",
    navigation: {
      kind: "live_block_range",
      relStart: "relative-start",
      relEnd: "relative-end",
      targetBlockId: { clientID: 7, clock: 11 },
    },
    swept: null,
    writerProtection: {
      kind: "sweep",
      body: { status: "available", markdown: "before" },
      ranges: [{ clientID: 7, clock: 11, length: 1 }],
    },
    reversible: false,
  };
}

describe("change-trail Yjs identities", () => {
  it.each([
    ["canonical clientID", (change: TrailChangeV1) => change.beforeBlockIdentity, "clientID", -1],
    ["canonical clock", (change: TrailChangeV1) => change.beforeBlockIdentity, "clock", -1],
    [
      "writer range clientID",
      (change: TrailChangeV1) =>
        change.writerProtection?.kind === "sweep" ? change.writerProtection.ranges?.[0] : undefined,
      "clientID",
      Number.MAX_SAFE_INTEGER + 1,
    ],
    [
      "writer range clock",
      (change: TrailChangeV1) =>
        change.writerProtection?.kind === "sweep" ? change.writerProtection.ranges?.[0] : undefined,
      "clock",
      Number.MAX_SAFE_INTEGER + 1,
    ],
  ] as const)("rejects an out-of-range %s", (_case, selectIdentity, field, value) => {
    const change = validChange();
    const identity = selectIdentity(change);
    if (!identity) throw new Error("invalid test fixture");
    identity[field] = value;

    expect(() => parseTrailChangesV1([change])).toThrow("Corrupt change-trail detail");
  });
});
