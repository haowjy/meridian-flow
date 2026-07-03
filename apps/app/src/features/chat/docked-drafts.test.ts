import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { activeDockedDraftGroups, dockedDraftCountKey } from "./docked-drafts";

const baseDraft = {
  documentName: null,
  contextPath: null,
  lastActorTurnId: null,
  updatedAt: "2026-07-03T00:00:00.000Z",
} satisfies Omit<ThreadDraftListItem, "draftId" | "documentId" | "status">;

function group(documentId: string, statuses: ThreadDraftListItem["status"][]): ThreadDraftGroup {
  return {
    documentId,
    documentName: documentId,
    contextPath: `/docs/${documentId}`,
    drafts: statuses.map((status, index) => ({
      ...baseDraft,
      draftId: `${documentId}-${status}-${index}`,
      documentId,
      status,
    })),
  };
}

describe("docked draft assembly", () => {
  it("keeps only active drafts from a mix of active and terminal drafts", () => {
    const result = activeDockedDraftGroups([
      group("doc-a", ["discarded", "applied"]),
      group("doc-b", ["active", "applied"]),
      group("doc-c", ["discarded", "active"]),
    ]);

    expect(result.map((item) => item.documentId)).toEqual(["doc-b", "doc-c"]);
    expect(result.flatMap((item) => item.drafts).map((draft) => draft.status)).toEqual([
      "active",
      "active",
    ]);
  });

  it("keys collapse reset by active document count and per-document active count", () => {
    expect(dockedDraftCountKey([group("doc-a", ["active"]), group("doc-b", ["active"])])).toBe(
      "doc-a:1|doc-b:1",
    );
  });
});
