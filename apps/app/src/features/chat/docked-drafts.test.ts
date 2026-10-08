/** One file order for every list of draft files, and "Next draft" that follows it. */
import { describe, expect, it } from "vitest";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { dockRows, draftAfter, sortDraftFiles } from "./docked-drafts";

const group = (
  documentId: string,
  documentName: string | null,
  updatedAt = "2026-01-01T00:00:00Z",
) =>
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
      lastActorTurnId: null,
      updatedAt,
      wordsAdded: 3,
      wordsRemoved: 0,
    },
  }) as unknown as ThreadDraftGroup;

describe("the file order", () => {
  it("is by name then id, and does not move when a draft is updated", () => {
    const before = [group("2", "Chapter 13"), group("1", "Chapter 12"), group("3", "Interlude")];
    const after = [
      group("2", "Chapter 13", "2026-02-01T00:00:00Z"),
      group("1", "Chapter 12"),
      group("3", "Interlude", "2026-03-01T00:00:00Z"),
    ];
    const names = (groups: ThreadDraftGroup[]) => dockRows(groups).map((row) => row.documentName);
    expect(names(before)).toEqual(["Chapter 12", "Chapter 13", "Interlude"]);
    expect(names(after)).toEqual(names(before));
  });

  it("orders a file with no name by its path's name, and ties by id", () => {
    const sorted = sortDraftFiles([
      { documentId: "b", documentName: null, contextPath: "manuscript://notes/zeta.md" },
      { documentId: "a", documentName: "Zeta", contextPath: null },
      { documentId: "c", documentName: "Alpha", contextPath: null },
    ]);
    expect(sorted.map((file) => file.documentId)).toEqual(["c", "a", "b"]);
  });
});

describe("draftAfter", () => {
  const rows = dockRows([
    group("1", "Chapter 12"),
    group("2", "Chapter 13"),
    group("3", "Interlude"),
  ]);

  it("is the next file in the order, wrapping, and none when this is the only one", () => {
    expect(draftAfter(rows, "1")?.documentId).toBe("2");
    expect(draftAfter(rows, "3")?.documentId).toBe("1");
    expect(draftAfter(rows.slice(0, 1), "1")).toBeNull();
  });

  it("keeps the place of a file whose draft has left the list", () => {
    const left = rows.filter((row) => row.documentId !== "2");
    expect(draftAfter(left, "2", "Chapter 13")?.documentId).toBe("3");
    expect(draftAfter(left, "2")?.documentId).toBe("1");
  });
});
