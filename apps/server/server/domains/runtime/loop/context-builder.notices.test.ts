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

  it("omits legacy sweep notices from model context", () => {
    expect(
      formatSafetyNotices([
        notice("push_swept", {
          affectedBlockHashes: ["missing"],
          capturedDeletedBodies: [{ hash: "missing", body: "body_unavailable" }],
        }),
      ]),
    ).toBe("");
  });
});
