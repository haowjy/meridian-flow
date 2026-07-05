/** Route-core coverage for per-turn edited document lineage serialization. */
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { handleTurnLiveLineageRequest } from "./turn-live-lineage-route.js";

const projectId = "00000000-0000-4000-8000-000000000701" as ProjectId;
const threadId = "00000000-0000-4000-8000-000000000702" as ThreadId;
const turnId = "00000000-0000-4000-8000-000000000703" as TurnId;
const userId = "00000000-0000-4000-8000-000000000704" as UserId;
const draftDocumentId = "00000000-0000-4000-8000-000000000705";
const liveDocumentId = "00000000-0000-4000-8000-000000000706";
const inaccessibleDocumentId = "00000000-0000-4000-8000-000000000707";
const crossProjectDocumentId = "00000000-0000-4000-8000-000000000708";

type EditedDocument = {
  documentId: string;
  uri: string;
  scope: "live" | "draft";
};

const manuscriptDraftDocument: EditedDocument = {
  documentId: draftDocumentId,
  uri: "manuscript://manuscript/Chapter 1.md",
  scope: "draft",
};

const manuscriptLiveDocument: EditedDocument = {
  documentId: liveDocumentId,
  uri: "manuscript://manuscript/Chapter 2.md",
  scope: "live",
};

function deps({
  documents = [manuscriptDraftDocument],
  canAccessDocument = async () => true,
  canAccessProjectDocument = async () => true,
}: {
  documents?: EditedDocument[];
  canAccessDocument?: (documentId: string) => Promise<boolean>;
  canAccessProjectDocument?: (documentId: string) => Promise<boolean>;
} = {}) {
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
      canAccessDocument: vi.fn(async (_userId: UserId, checkedDocumentId: string) =>
        canAccessDocument(checkedDocumentId),
      ),
      canAccessProjectDocument: vi.fn(
        async (_userId: UserId, checkedDocumentId: string, _projectId: ProjectId) =>
          canAccessProjectDocument(checkedDocumentId),
      ),
    },
    documentSync: {
      listEditedDocumentsForTurn: vi.fn(async () => documents),
    },
  };
}

describe("turn live-lineage route", () => {
  it("serializes draft-scope manuscript edits without requiring an upload row", async () => {
    await expect(
      handleTurnLiveLineageRequest(deps() as never, { threadId, turnId, userId }),
    ).resolves.toEqual({
      documents: [
        {
          documentId: draftDocumentId,
          uri: "manuscript://manuscript/Chapter 1.md",
          path: "/manuscript/Chapter 1.md",
          scope: "draft",
        },
      ],
    });
  });

  it("serializes live-scope manuscript edits without requiring an upload row", async () => {
    await expect(
      handleTurnLiveLineageRequest(deps({ documents: [manuscriptLiveDocument] }) as never, {
        threadId,
        turnId,
        userId,
      }),
    ).resolves.toEqual({
      documents: [
        {
          documentId: liveDocumentId,
          uri: "manuscript://manuscript/Chapter 2.md",
          path: "/manuscript/Chapter 2.md",
          scope: "live",
        },
      ],
    });
  });

  it("drops documents that fail document or project access", async () => {
    await expect(
      handleTurnLiveLineageRequest(
        deps({
          documents: [
            manuscriptDraftDocument,
            {
              documentId: inaccessibleDocumentId,
              uri: "manuscript://manuscript/private.md",
              scope: "draft",
            },
            {
              documentId: crossProjectDocumentId,
              uri: "manuscript://manuscript/other-project.md",
              scope: "live",
            },
          ],
          canAccessDocument: async (checkedDocumentId) =>
            checkedDocumentId !== inaccessibleDocumentId,
          canAccessProjectDocument: async (checkedDocumentId) =>
            checkedDocumentId !== crossProjectDocumentId,
        }) as never,
        { threadId, turnId, userId },
      ),
    ).resolves.toEqual({
      documents: [
        {
          documentId: draftDocumentId,
          uri: "manuscript://manuscript/Chapter 1.md",
          path: "/manuscript/Chapter 1.md",
          scope: "draft",
        },
      ],
    });
  });
});
