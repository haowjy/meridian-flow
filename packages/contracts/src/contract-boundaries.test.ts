/**
 * Tests contract boundaries behavior.
 */

import { describe, expect, it } from "vitest";
import { parseThreadReportResult, toReportContentValue } from "./spawn/index.js";
import { parseWorkReceipt } from "./works/receipts.js";

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
