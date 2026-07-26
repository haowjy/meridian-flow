/** Canonical pending Work-draft classification contracts. */
import type { WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type { BranchJournalRow } from "./branch-push-contracts.js";
import { createWorkDraftPending } from "./work-draft-pending.js";

const WORK_ID = "00000000-0000-4000-8000-000000000001" as WorkId;

describe("pending Work drafts", () => {
  it("counts reviewable content branches rather than journal rows or manifest bookkeeping", async () => {
    const content = workDraft("content");
    const manifest = workDraft("manifest");
    const rows = new Map<string, BranchJournalRow[]>([
      ["content", [journalRow(1), journalRow(2)]],
      [
        "manifest",
        [
          journalRow(3, {
            kind: "manifest_membership",
            present: true,
            documentId: "00000000-0000-4000-8000-000000000004",
          }),
        ],
      ],
    ]);
    const pending = createWorkDraftPending({
      branches: {
        getBranch: vi.fn(async (branchId) => (branchId === content.branchId ? content : manifest)),
      },
      branchJournal: {
        listReviewableJournalRows: vi.fn(async (branchId) => rows.get(branchId) ?? []),
      },
      workDraftIndex: {
        listActiveWorkDraftBranchIdsForWork: vi.fn(async () => [
          content.branchId,
          manifest.branchId,
        ]),
      },
    });

    await expect(pending.list(WORK_ID)).resolves.toEqual([
      { branch: content, rows: rows.get("content") },
    ]);
    await expect(pending.count(WORK_ID)).resolves.toBe(1);
  });
});

function workDraft(branchId: string): BranchSnapshot {
  return {
    branchId,
    documentId: "00000000-0000-4000-8000-000000000003",
    kind: "work_draft",
    upstreamBranchId: null,
    workId: WORK_ID,
    threadId: null,
    pushPolicy: "manual",
    status: "active",
    generation: 1,
    state: new Uint8Array(),
    stateVector: new Uint8Array(),
    schemaVersion: 1,
  } as BranchSnapshot;
}

function journalRow(id: number, updateMeta?: unknown): BranchJournalRow {
  return {
    id,
    branchId: "",
    generation: 1,
    wId: null,
    source: "agent",
    threadId: null,
    turnId: null,
    actorUserId: null,
    updateData: new Uint8Array(),
    draftBaseUpdateSeq: 0,
    status: "active",
    ...(updateMeta === undefined ? {} : { updateMeta }),
  };
}
