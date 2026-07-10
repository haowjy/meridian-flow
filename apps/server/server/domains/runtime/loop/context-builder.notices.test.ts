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

  it("renders every resolved document name for degraded awareness", () => {
    expect(
      formatSafetyNotices([
        notice("awareness_degraded", {
          documentIds: ["internal-1", "internal-2"],
          documentNames: ["chapter-one", "chapter-two"],
        }),
      ]),
    ).toContain("chapter-one, chapter-two");
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

  it("shows swept bodies to the model when a push cannot be reversed", () => {
    const formatted = formatSafetyNotices([
      notice("push_swept", {
        documentName: "chapter-one.md",
        affectedBlockHashes: ["available", "missing"],
        capturedDeletedBodies: [
          { hash: "available", body: "Writer sentence." },
          { hash: "missing", body: "body_unavailable" },
        ],
        reversible: false,
      }),
    ]);

    expect(formatted).toContain("available: Writer sentence.");
    expect(formatted).toContain("missing: This block's earlier content could not be recovered.");
  });

  it("states the undo affordance in addition to swept bodies when reversible", () => {
    const formatted = formatSafetyNotices([
      notice("push_swept", {
        documentName: "chapter-one.md",
        affectedBlockHashes: ["available"],
        capturedDeletedBodies: [{ hash: "available", body: "Writer sentence." }],
        reversible: true,
      }),
    ]);

    expect(formatted).toContain("The writer can undo the change.");
    expect(formatted).toContain("Writer sentence.");
  });
});
