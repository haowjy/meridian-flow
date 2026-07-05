import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { activeDockedDraftGroups, dockedDraftCountKey, dockRows } from "./docked-drafts";

const baseDraft = {
  documentName: null,
  contextPath: null,
  lastActorTurnId: null,
  updatedAt: "2026-07-03T00:00:00.000Z",
  appliedAt: null,
  discardedAt: null,
  wordsAdded: null,
  wordsRemoved: null,
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

describe("dockRows", () => {
  const NOW = Date.parse("2026-07-04T12:00:00.000Z");

  function terminalGroup(documentId: string, status: "applied" | "discarded"): ThreadDraftGroup {
    const closedAt = "2026-07-04T11:59:30.000Z"; // inside the undo retention window
    return {
      documentId,
      documentName: documentId,
      contextPath: `/docs/${documentId}`,
      drafts: [
        {
          ...baseDraft,
          draftId: `${documentId}-${status}`,
          documentId,
          status,
          updatedAt: closedAt,
          appliedAt: status === "applied" ? closedAt : null,
          discardedAt: status === "discarded" ? closedAt : null,
        },
      ],
    };
  }

  it("orders pending rows before reviewed rows, each stable by document", () => {
    const rows = dockRows(
      [
        terminalGroup("b-reviewed", "applied"),
        group("c-pending", ["active"]),
        group("a-pending", ["active"]),
      ],
      NOW,
    );

    expect(rows.map((row) => `${row.documentId}:${row.state}`)).toEqual([
      "a-pending:pending",
      "c-pending:pending",
      "b-reviewed:reviewed",
    ]);
  });

  it("drops documents whose drafts are neither active nor recently terminal", () => {
    const staleClosedAt = "2026-06-01T00:00:00.000Z";
    const rows = dockRows(
      [
        {
          documentId: "stale",
          documentName: "stale",
          contextPath: null,
          drafts: [
            {
              ...baseDraft,
              draftId: "stale-applied",
              documentId: "stale",
              status: "applied",
              updatedAt: staleClosedAt,
              appliedAt: staleClosedAt,
            },
          ],
        },
      ],
      NOW,
    );

    expect(rows).toEqual([]);
  });
});
