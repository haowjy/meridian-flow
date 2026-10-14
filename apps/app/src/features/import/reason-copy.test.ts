import { describe, expect, it } from "vitest";
import { runSentence } from "./reason-copy";
import type { ImportRunInfo } from "./tree-rows";

const run = (total: number, arrived: number): ImportRunInfo => ({
  importId: "i",
  kind: "sending",
  arrived,
  total,
  failed: 0,
  remaining: total - arrived,
  canRetry: false,
});

describe("run sentence plurals", () => {
  it("agrees with the file total", () => {
    expect(runSentence(run(1, 0))).toContain("0 of 1 file has arrived.");
    expect(runSentence(run(5, 2))).toContain("2 of 5 files have arrived.");
  });
});
