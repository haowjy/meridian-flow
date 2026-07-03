import type { Project } from "@meridian/contracts/projects";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Draft,
  DraftAcceptResult,
  DraftRejectResult,
  DraftUndoDomainResult,
} from "../domains/collab/domain/drafts.js";
import {
  handleWorkDraftAcceptRequest,
  handleWorkDraftJournalRequest,
  handleWorkDraftListRequest,
  handleWorkDraftPreviewRequest,
  handleWorkDraftRejectRequest,
  handleWorkDraftUndoAcceptRequest,
  handleWorkDraftUndoRejectRequest,
} from "./draft-review-route.js";

vi.mock("nitro/h3", () => ({
  createError: (input: { statusCode: number; message: string; data?: unknown }) =>
    Object.assign(new Error(input.message), input),
}));

type DraftRouteServices = Parameters<typeof handleWorkDraftPreviewRequest>[0];

const userId = "00000000-0000-4000-8000-000000000401";
const projectId = "00000000-0000-4000-8000-000000000402";
const workId = "00000000-0000-4000-8000-000000000409" as never;
const otherWorkId = "00000000-0000-4000-8000-000000000410" as never;
const documentId = "00000000-0000-4000-8000-000000000404";
const primaryThreadId = "00000000-0000-4000-8000-000000000405" as never;

describe("work-scoped draft review route core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns live markdown and no preview when there is no active draft", async () => {
    const deps = makeDeps();

    await expect(
      handleWorkDraftPreviewRequest(deps, { projectId, workId, documentId, userId }),
    ).resolves.toEqual({
      status: "gone",
      live: "Live",
    });
  });

  it("returns live and preview markdown for an active draft", async () => {
    const deps = makeDeps({
      activeDraft: draft({ id: "draft-1", status: "active" }),
    });

    await expect(
      handleWorkDraftPreviewRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
      }),
    ).resolves.toEqual({
      status: "active",
      draftId: "draft-1",
      live: "Live",
      preview: "Preview",
      liveRevisionToken: 7,
      draftRevisionToken: 11,
      inlineModelPresent: true,
      operations: [],
      hunks: [],
    });
  });

  it("returns the active draft journal when the revision token matches", async () => {
    const deps = makeDeps({
      activeDraft: draft({ id: "draft-1", status: "active" }),
      journalResult: {
        status: "active",
        draftRevisionToken: 11,
        checkpoint: new Uint8Array([1, 2]),
        updates: [{ seq: 11, update: new Uint8Array([3, 4]) }],
      },
    });

    await expect(
      handleWorkDraftJournalRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        revisionToken: 11,
        userId,
      }),
    ).resolves.toEqual({
      draftId: "draft-1",
      draftRevisionToken: 11,
      checkpoint: Buffer.from([1, 2]).toString("base64"),
      updates: [{ seq: 11, update: Buffer.from([3, 4]).toString("base64") }],
    });
  });

  it("returns 409 when the journal revision token is stale", async () => {
    const deps = makeDeps({
      activeDraft: draft({ id: "draft-1", status: "active" }),
      journalResult: {
        status: "active",
        draftRevisionToken: 12,
        checkpoint: null,
        updates: [],
      },
    });

    await expect(
      handleWorkDraftJournalRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        revisionToken: 11,
        userId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("maps applied accept results to the wire shape", async () => {
    const deps = makeDeps({
      activeDraft: draft({ id: "draft-1", status: "active" }),
      storedDraft: draft({ id: "draft-1", status: "active" }),
      acceptResult: { status: "applied", draftId: "draft-1", appliedUpdateSeq: 42 },
    });

    await expect(
      handleWorkDraftAcceptRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).resolves.toEqual({ status: "applied", draftId: "draft-1" });
  });

  it("maps overlap accept results without overlappingBlocks", async () => {
    const deps = makeDeps({
      storedDraft: draft({ id: "draft-1", status: "active" }),
      acceptResult: {
        status: "overlap",
        draftId: "draft-1",
        liveRevisionToken: 9,
        live: "Live",
        preview: "Preview",
        overlappingBlocks: ["block-1"],
      },
    });

    await expect(
      handleWorkDraftAcceptRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).resolves.toEqual({
      status: "overlap",
      draftId: "draft-1",
      liveRevisionToken: 9,
      live: "Live",
      preview: "Preview",
    });
  });

  it("returns 404 when the draft belongs to another work", async () => {
    const deps = makeDeps({
      storedDraft: draft({ id: "draft-1", workId: otherWorkId }),
    });

    await expect(
      handleWorkDraftAcceptRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(deps.documentSync.drafts.acceptDraft).not.toHaveBeenCalled();
  });

  it("resolves reject through the work primary thread", async () => {
    const deps = makeDeps({
      storedDraft: draft({ id: "draft-1", status: "active" }),
      rejectResult: { status: "discarded", draftId: "draft-1" },
    });

    await expect(
      handleWorkDraftRejectRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
      }),
    ).resolves.toEqual({ status: "discarded", draftId: "draft-1" });
    expect(deps.documentSync.drafts.rejectDraft).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: primaryThreadId, draftId: "draft-1" }),
    );
  });

  it("returns 404 when document access fails", async () => {
    const deps = makeDeps({ hasDocumentAccess: false });

    await expect(
      handleWorkDraftPreviewRequest(deps, { projectId, workId, documentId, userId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("maps undo accept success", async () => {
    const deps = makeDeps({
      storedDraft: draft({ id: "draft-1", status: "applied" }),
      undoAcceptResult: { status: "reactivated", draftId: "draft-1" },
    });

    await expect(
      handleWorkDraftUndoAcceptRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: "draft-1" });
  });

  it("maps undo reject success", async () => {
    const deps = makeDeps({
      storedDraft: draft({ id: "draft-1", status: "discarded" }),
      undoRejectResult: { status: "reactivated", draftId: "draft-1" },
    });

    await expect(
      handleWorkDraftUndoRejectRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: "draft-1" });
  });

  it("lists reviewable drafts for the work", async () => {
    const deps = makeDeps({
      reviewableDrafts: [
        {
          ...draft({ id: "draft-1" }),
          status: "active" as const,
          documentName: "Chapter 1",
          contextPath: "/chapter-1",
        },
      ] as Awaited<
        ReturnType<DraftRouteServices["documentSync"]["drafts"]["listReviewableDraftsByWork"]>
      >,
    });

    await expect(handleWorkDraftListRequest(deps, { projectId, workId, userId })).resolves.toEqual({
      drafts: [
        expect.objectContaining({
          draftId: "draft-1",
          documentName: "Chapter 1",
          contextPath: "/chapter-1",
        }),
      ],
    });
  });
});

function makeDeps(
  options: {
    hasDocumentAccess?: boolean;
    isProjectDocument?: boolean;
    activeDraft?: Draft;
    storedDraft?: Draft;
    acceptResult?: DraftAcceptResult;
    rejectResult?: DraftRejectResult;
    undoAcceptResult?: DraftUndoDomainResult;
    undoRejectResult?: DraftUndoDomainResult;
    reviewableDrafts?: Awaited<
      ReturnType<DraftRouteServices["documentSync"]["drafts"]["listReviewableDraftsByWork"]>
    >;
    journalResult?: Awaited<
      ReturnType<DraftRouteServices["documentSync"]["drafts"]["getDraftJournal"]>
    >;
  } = {},
): DraftRouteServices {
  const drafts = {
    getDraft: vi.fn(
      async (draftId: string) =>
        options.storedDraft ?? options.activeDraft ?? draft({ id: draftId }),
    ),
    getActiveDraftByWork: vi.fn(async () => options.activeDraft ?? null),
    resolvePrimaryThreadForWork: vi.fn(async () => primaryThreadId),
    resolveDraftThreadId: vi.fn(async () => primaryThreadId),
    previewDraft: vi.fn(async () => ({
      live: "Live",
      markdown: "Preview",
      liveRevisionToken: 7,
      draftRevisionToken: 11,
      inlineModelPresent: true,
      operations: [],
      hunks: [],
    })),
    acceptDraft: vi.fn(async () => options.acceptResult ?? ({ status: "not_found" } as const)),
    rejectDraft: vi.fn(async () => options.rejectResult ?? ({ status: "not_found" } as const)),
    undoAcceptDraft: vi.fn(
      async () => options.undoAcceptResult ?? ({ status: "not_found" } as const),
    ),
    undoRejectDraft: vi.fn(
      async () => options.undoRejectResult ?? ({ status: "not_found" } as const),
    ),
    listReviewableDraftsByWork: vi.fn(async () => options.reviewableDrafts ?? []),
    getDraftJournal: vi.fn(async () => options.journalResult ?? { status: "not_found" as const }),
  };

  return {
    projects: {
      findById: vi.fn(async () => project()),
    },
    works: {
      findById: vi.fn(async () => ({
        id: workId,
        projectId,
        createdByUserId: userId,
        title: "Work",
        visibility: "private" as const,
        aiWriteMode: "draft" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      })),
    },
    documentAccess: {
      canAccessDocument: vi.fn(async () => options.hasDocumentAccess ?? true),
      canAccessProjectDocument: vi.fn(async () => options.isProjectDocument ?? true),
    },
    documentSync: {
      readAsMarkdown: vi.fn(async () => ({ ok: true as const, value: "Live" })),
      drafts,
    },
  };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "draft-1",
    documentId: documentId as never,
    workId,
    status: "active",
    baseLiveUpdateSeq: 1,
    acceptGeneration: 1,
    createdDocument: false,
    lastActorTurnId: null,
    appliedAt: null,
    appliedByUserId: null,
    appliedUpdateSeq: null,
    discardedAt: null,
    undoneAt: null,
    claimedAt: null,
    claimToken: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: projectId,
    userId,
    name: "Project",
    title: "Project",
    slug: "project",
    isPersonal: false,
    systemPrompt: null,
    description: null,
    settings: {},
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}
