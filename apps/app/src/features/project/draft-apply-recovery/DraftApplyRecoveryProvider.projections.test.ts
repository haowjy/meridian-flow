/** Truthful server-active and command-eligible draft projection proofs. */
import { describe, expect, it } from "vitest";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import type { PostApplySnapshot } from "./draft-apply-recovery-owner";
import { projectPostApplyDraftGroups } from "./draft-group-projections";

describe("projectPostApplyDraftGroups", () => {
  it("keeps an outcome-unknown server row counted while removing its command eligibility", () => {
    const identity = {
      accountId: "account-1",
      projectId: "project-1",
      workId: "work-1",
      documentId: "doc-1",
      draftId: "draft-1",
    };
    const groups = [
      {
        documentId: identity.documentId,
        documentName: "Chapter",
        contextPath: "chapter.md",
        drafts: [
          {
            ...identity,
            status: "active",
            updatedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
      },
    ] as unknown as ThreadDraftGroup[];
    const snapshot: PostApplySnapshot = {
      nextVersion: 2,
      reservations: [
        {
          identity,
          reservationVersion: 1,
          phase: "outcome-unknown",
          checkVersion: 0,
          dispatchVersion: 1,
          presentation: {
            documentName: "Chapter",
            contextPath: "chapter.md",
            owningWorkLabel: "Work one",
          },
          obligations: { draftTab: { kind: "none" }, branch: { kind: "none" } },
        },
      ],
      items: [],
      appliedSuppressions: [],
      remoteDraftWitnesses: [],
    };
    const result = projectPostApplyDraftGroups(
      groups,
      snapshot,
      identity.accountId,
      identity.projectId,
      identity.workId,
    );
    expect(result.serverActiveGroups).toHaveLength(1);
    expect(result.commandEligibleGroups).toEqual([]);
  });
});
