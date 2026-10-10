/** One file order for every list of draft files, and "Next draft" that follows it. */
import { describe, expect, it } from "vitest";

import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { sortDraftFiles } from "@/client/query/work-draft-files";
import { nextReviewFile } from "./review-files";

const group = (documentId: string, documentName: string | null) =>
  ({
    documentId,
    documentName,
    contextPath: documentName ? `manuscript://${documentName}.md` : `manuscript://${documentId}.md`,
    draft: {
      draftId: `draft-${documentId}`,
      documentId,
      documentName,
      contextPath: null,
      status: "active",
      actorThreads: [],
    },
  }) as unknown as ReviewFileTarget;

describe("the file order", () => {
  it("orders a file with no name by its path's name, and ties by id", () => {
    const sorted = sortDraftFiles([
      { documentId: "b", documentName: null, contextPath: "manuscript://notes/zeta.md" },
      { documentId: "a", documentName: "Zeta", contextPath: null },
      { documentId: "c", documentName: "Alpha", contextPath: null },
    ]);
    expect(sorted.map((file) => file.documentId)).toEqual(["c", "a", "b"]);
  });
});

describe("nextReviewFile", () => {
  const rows = sortDraftFiles([
    group("1", "Chapter 12"),
    group("2", "Chapter 13"),
    group("3", "Interlude"),
  ]);

  it("is the next file in the order, wrapping, and none when this is the only one", () => {
    expect(nextReviewFile(rows, "1")?.documentId).toBe("2");
    expect(nextReviewFile(rows, "3")?.documentId).toBe("1");
    expect(nextReviewFile(rows.slice(0, 1), "1")).toBeNull();
  });

  it("keeps the place of a file whose draft has left the list", () => {
    const left = rows.filter((row) => row.documentId !== "2");
    expect(nextReviewFile(left, "2", "Chapter 13")?.documentId).toBe("3");
    expect(nextReviewFile(left, "2")?.documentId).toBe("1");
  });
});
