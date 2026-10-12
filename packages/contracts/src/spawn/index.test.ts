import { expect, it } from "vitest";
import { parseThreadReportResult, toReportContentValue } from "./index.js";

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
