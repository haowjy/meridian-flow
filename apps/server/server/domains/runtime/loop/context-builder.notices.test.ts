/** Formatting coverage for typed model-facing safety notices. */
import { describe, expect, it } from "vitest";
import type { Notice } from "../../notices/index.js";
import { formatSafetyNotices } from "./context-builder.js";

function notice(kind: string, data: Record<string, unknown>, message = "fallback"): Notice {
  return {
    id: 1,
    kind,
    scope: { kind: "thread", threadId: "thread-1" },
    message,
    data,
    writerVisible: false,
    createdAt: new Date(0),
  };
}

describe("formatSafetyNotices", () => {
  it("states honestly when concurrent-content awareness degraded", () => {
    expect(
      formatSafetyNotices([notice("awareness_degraded", { documentName: "chapter-one.md" })]),
    ).toBe(
      "The system could not verify whether concurrent writer content was preserved in chapter-one.md. Re-read the document before making another write.",
    );
  });

  it("formats checkpoint sweep receipts with the count and before reference", () => {
    expect(
      formatSafetyNotices([
        notice("checkpoint_sweep", {
          documentName: "chapter-one.md",
          discardedBlockCount: 2,
          beforeContentRef: 42,
        }),
      ]),
    ).toContain("discarded 2 concurrent blocks in chapter-one.md");
    expect(
      formatSafetyNotices([
        notice("checkpoint_sweep", {
          documentName: "chapter-one.md",
          discardedBlockCount: 2,
          beforeContentRef: 42,
        }),
      ]),
    ).toContain("Before-state journal reference: 42");
  });
});
