/** Unit coverage for local execution-turn metadata rules. */

import { describe, expect, it } from "vitest";
import { readCompactionTrigger } from "./local-turn.js";

describe("readCompactionTrigger", () => {
  it("reads a manual no-compaction reservation without requiring outcome metadata", () => {
    expect(
      readCompactionTrigger({
        trigger: "manual",
        controlMessageId: crypto.randomUUID(),
        instructions: "Keep the important details.",
      }),
    ).toBe("manual");
  });

  it("defaults absent trigger metadata to automatic behavior", () => {
    expect(readCompactionTrigger(null)).toBe("auto");
  });
});
