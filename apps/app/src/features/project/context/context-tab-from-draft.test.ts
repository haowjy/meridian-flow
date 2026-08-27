import { describe, expect, it } from "vitest";
import { contextTabFromDraftGroup } from "./context-tab-from-draft";

describe("contextTabFromDraftGroup", () => {
  it("carries transient review Work without changing manuscript document location", () => {
    expect(
      contextTabFromDraftGroup({
        workId: "work-a",
        documentId: "document-1",
        contextPath: "/chapter.md",
        isNewDocument: true,
      }),
    ).toMatchObject({
      scheme: "manuscript",
      documentId: "document-1",
      draftOnly: true,
      reviewWorkId: "work-a",
    });
    expect(
      contextTabFromDraftGroup({
        workId: "work-a",
        documentId: "document-1",
        contextPath: "/chapter.md",
        isNewDocument: true,
      }),
    ).not.toHaveProperty("workId");
  });
});
