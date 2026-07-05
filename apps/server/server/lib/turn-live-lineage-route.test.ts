/** Route-core coverage for per-turn edited document lineage serialization. */
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { handleTurnLiveLineageRequest } from "./turn-live-lineage-route.js";

const projectId = "00000000-0000-4000-8000-000000000701" as ProjectId;
const threadId = "00000000-0000-4000-8000-000000000702" as ThreadId;
const turnId = "00000000-0000-4000-8000-000000000703" as TurnId;
const userId = "00000000-0000-4000-8000-000000000704" as UserId;
const documentId = "00000000-0000-4000-8000-000000000705";

function deps() {
  return {
    threads: {
      findById: vi.fn(async () => ({
        id: threadId,
        projectId,
        userId,
        deletedAt: null,
      })),
    },
    projects: {
      findById: vi.fn(async () => ({ id: projectId, userId, deletedAt: null })),
    },
    documentAccess: {
      canAccessDocument: vi.fn(async () => true),
      canAccessProjectDocument: vi.fn(async () => true),
    },
    uploadDocuments: {
      getUpload: vi.fn(async () => ({ id: documentId })),
    },
    documentSync: {
      listEditedDocumentsForTurn: vi.fn(async () => [
        {
          documentId,
          uri: "manuscript://manuscript/Chapter 1.md",
          scope: "draft" as const,
        },
      ]),
    },
  };
}

describe("turn live-lineage route", () => {
  it("serializes draft-scope edited documents without requiring live undo authority", async () => {
    await expect(
      handleTurnLiveLineageRequest(deps() as never, { threadId, turnId, userId }),
    ).resolves.toEqual({
      documents: [
        {
          documentId,
          uri: "manuscript://manuscript/Chapter 1.md",
          path: "/manuscript/Chapter 1.md",
          scope: "draft",
        },
      ],
    });
  });
});
