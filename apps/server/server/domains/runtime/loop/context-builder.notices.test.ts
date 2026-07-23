/** Formatting coverage for typed model-context notices. */
import { describe, expect, it } from "vitest";
import type { Notice } from "../../notices/index.js";
import { formatNotices } from "./context-builder.js";

function notice(kind: string, data: Record<string, unknown>, message = "fallback"): Notice {
  return {
    id: 1,
    kind,
    scope: { kind: "thread", threadId: "thread-1" },
    message,
    data,
    createdAt: new Date(0),
  };
}

describe("formatNotices", () => {
  it("states honestly when concurrent-content awareness degraded", () => {
    expect(formatNotices([notice("awareness_degraded", { documentName: "chapter-one.md" })])).toBe(
      "The system could not verify whether concurrent writer content was preserved in chapter-one.md. Re-read the document before making another write.",
    );
  });

  it("renders every resolved document name for degraded awareness", () => {
    expect(
      formatNotices([
        notice("awareness_degraded", {
          documentIds: ["internal-1", "internal-2"],
          documentNames: ["chapter-one", "chapter-two"],
        }),
      ]),
    ).toContain("chapter-one, chapter-two");
  });

  it("omits legacy sweep notices from model context", () => {
    expect(
      formatNotices([
        notice("push_swept", {
          affectedBlockHashes: ["missing"],
          capturedDeletedBodies: [{ hash: "missing", body: "body_unavailable" }],
        }),
      ]),
    ).toBe("");
  });
});
