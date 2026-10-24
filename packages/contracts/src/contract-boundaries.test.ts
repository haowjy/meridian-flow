import { describe, expect, it } from "vitest";
import { parseTrailChangesV1, type TrailChangeV1 } from "./change-trails.js";
import { normalizeInterruptAnswerValue } from "./components/index.js";
import { parseThreadReportResult, toReportContentValue } from "./spawn/index.js";
import { parseWorkReceipt } from "./works/receipts.js";

function validChange(): TrailChangeV1 {
  return {
    changeId: "change-1",
    ordinal: 0,
    documentId: "document-1",
    pushId: "push-1",
    receiptId: "receipt-1",
    kind: "modify",
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
  };
}

describe("change-trail Yjs identities", () => {
  it.each([
    ["canonical clientID", (change: TrailChangeV1) => change.beforeBlockIdentity, "clientID", -1],
  ] as const)("rejects an out-of-range %s", (_case, selectIdentity, field, value) => {
    const change = validChange();
    const identity = selectIdentity(change);
    if (!identity) throw new Error("invalid test fixture");
    identity[field] = value;

    expect(() => parseTrailChangesV1([change])).toThrow("Corrupt change-trail detail");
  });
});

describe("normalizeInterruptAnswerValue", () => {
  it("unwraps exactly one interrupt answer envelope", () => {
    expect(normalizeInterruptAnswerValue("direct")).toBe("direct");
    expect(normalizeInterruptAnswerValue({ value: "wrapped" })).toBe("wrapped");
    expect(normalizeInterruptAnswerValue({ value: { value: "nested" } })).toBe(
      JSON.stringify({ value: "nested" }),
    );
  });
});

it("parses a structured report authorization error without presenting it as a saved report", () => {
  const error = {
    ok: false,
    error: {
      code: "thread_not_connected",
      message: "Not connected",
      source: "system",
      retryable: false,
    },
  };
  expect(parseThreadReportResult(error)).toEqual(error);
  expect(toReportContentValue(parseThreadReportResult(error))).toBeNull();
});

describe("parseWorkReceipt", () => {
  it("keeps mutation changed state coupled to its inverse", () => {
    const receipt = {
      operation: "delete",
      changed: true,
      workId: "w1",
      workName: "Arc",
      before: { name: "Arc", goal: null, status: null, archived: false },
      after: null,
      inverse: { command: "restore", workId: "w1" },
    };
    expect(parseWorkReceipt(receipt)).toEqual(receipt);
    expect(parseWorkReceipt({ ...receipt, inverse: null })).toBeNull();
  });
});
