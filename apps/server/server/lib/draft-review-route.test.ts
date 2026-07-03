import type { Project } from "@meridian/contracts/projects";
import type { Thread } from "@meridian/contracts/threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Draft,
  DraftAcceptResult,
  DraftRejectResult,
  DraftUndoDomainResult,
} from "../domains/collab/domain/drafts.js";
import {
  handleDraftAcceptRequest,
  handleDraftJournalRequest,
  handleDraftPreviewRequest,
  handleDraftRejectRequest,
  handleDraftUndoAcceptRequest,
  handleDraftUndoRejectRequest,
  handleWorkDraftAcceptRequest,
  handleWorkDraftListRequest,
  handleWorkDraftRejectRequest,
} from "./draft-review-route.js";

vi.mock("nitro/h3", () => ({
  createError: (input: { statusCode: number; message: string; data?: unknown }) =>
    Object.assign(new Error(input.message), input),
}));

type DraftRouteServices = Parameters<typeof handleDraftPreviewRequest>[0];

const threadId = "thread-1";
const documentId = "doc-1";
const userId = "user-1";
const projectId = "project-1";
const workId = "work-1" as never;

describe("draft review route core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns live markdown and no preview when there is no active draft", async () => {
    const deps = makeDeps();

    await expect(
      handleDraftPreviewRequest(deps, { threadId, documentId, userId }),
    ).resolves.toEqual({
      status: "gone",
      live: "Live",
    });
  });

  it("returns live and preview markdown for an active draft", async () => {
    const deps = makeDeps({
      activeDraft: draft({
        id: "draft-1",
        status: "active",
        lastActorTurnId: "turn-1",
        updatedAt: new Date("2026-06-27T12:00:00.000Z"),
      }),
    });

    await expect(
      handleDraftPreviewRequest(deps, { threadId, documentId, draftId: "draft-1", userId }),
    ).resolves.toEqual({
      status: "active",
      draftId: "draft-1",
      live: "Live",
      preview: "Preview",
      liveRevisionToken: 7,
      draftRevisionToken: 11,
      recommendedSurface: "inline",
      inlineModelPresent: true,
      operations: [],
      hunks: [],
    });
  });

  it("threads the requested draft review surface into preview generation", async () => {
    const deps = makeDeps({
      activeDraft: draft({
        id: "draft-1",
        status: "active",
        lastActorTurnId: "turn-1",
        updatedAt: new Date("2026-06-27T12:00:00.000Z"),
      }),
    });

    await handleDraftPreviewRequest(deps, {
      threadId,
      documentId,
      draftId: "draft-1",
      userId,
      surface: "inline",
    });

    expect(deps.documentSync.drafts.previewDraft).toHaveBeenCalledWith({
      documentId,
      draftId: "draft-1",
      surface: "inline",
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
      handleDraftJournalRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        revisionToken: 11,
        userId,
      }),
    ).resolves.toEqual({
      draftId: "draft-1",
      draftRevisionToken: 11,
      checkpoint: "AQI=",
      updates: [{ seq: 11, update: "AwQ=" }],
    });
  });

  it("returns 409 stale_revision when the requested journal revision is old", async () => {
    const deps = makeDeps({
      activeDraft: draft({ id: "draft-1", status: "active" }),
      journalResult: { status: "active", draftRevisionToken: 12, checkpoint: null, updates: [] },
    });

    await expect(
      handleDraftJournalRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        revisionToken: 11,
        userId,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "stale_revision", currentRevisionToken: 12 },
    });
  });

  it("returns 404 for a missing or non-active draft journal", async () => {
    const deps = makeDeps({
      activeDraft: draft({ id: "draft-1", status: "active" }),
      journalResult: { status: "not_found" },
    });

    await expect(
      handleDraftJournalRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        revisionToken: 11,
        userId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("accepts a draft and returns the applied journal sequence", async () => {
    const deps = makeDeps({
      acceptResult: {
        status: "applied",
        draftId: "draft-1",
        appliedUpdateSeq: 42,
        acceptTurnId: "turn-accept",
      },
    });

    await expect(
      handleDraftAcceptRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).resolves.toEqual({
      status: "applied",
      draftId: "draft-1",
      appliedUpdateSeq: 42,
      acceptTurnId: "turn-accept",
    });
  });

  it("returns overlap details when accepting a draft needs writer confirmation", async () => {
    const deps = makeDeps({
      acceptResult: {
        status: "overlap",
        draftId: "draft-1",
        liveRevisionToken: 8,
        live: "Live changed",
        preview: "Draft preview",
        overlappingBlocks: ["block-1"],
      },
    });

    await expect(
      handleDraftAcceptRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).resolves.toEqual({
      status: "overlap",
      draftId: "draft-1",
      liveRevisionToken: 8,
      live: "Live changed",
      preview: "Draft preview",
      overlappingBlocks: ["block-1"],
    });
  });

  it("returns stale_draft details without throwing", async () => {
    const deps = makeDeps({
      acceptResult: { status: "stale_draft", draftId: "draft-1", draftRevisionToken: 12 },
    });

    await expect(
      handleDraftAcceptRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).resolves.toEqual({ status: "stale_draft", draftId: "draft-1", draftRevisionToken: 12 });
  });

  it("returns 409 invalid_created_document when accepting a racy created-document draft", async () => {
    const deps = makeDeps({
      acceptResult: { status: "invalid_created_document", draftId: "draft-1" },
    });

    await expect(
      handleDraftAcceptRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "invalid_created_document" },
    });
  });

  it.each<[string, DraftAcceptResult, number]>([
    ["missing", { status: "not_found" }, 404],
    ["already discarded", { status: "discarded", draftId: "draft-1" }, 410],
    ["accept in progress", { status: "in_progress", draftId: "draft-1" }, 409],
  ])("returns HTTP error for %s accept result", async (_label, acceptResult, statusCode) => {
    const deps = makeDeps({ acceptResult });

    await expect(
      handleDraftAcceptRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        userId,
        draftRevisionToken: 11,
      }),
    ).rejects.toMatchObject({ statusCode });
  });

  it("rejects a draft", async () => {
    const deps = makeDeps({
      rejectResult: { status: "discarded", draftId: "draft-1", rejectTurnId: "turn-reject" },
    });

    await expect(
      handleDraftRejectRequest(deps, { threadId, documentId, draftId: "draft-1", userId }),
    ).resolves.toEqual({
      status: "discarded",
      draftId: "draft-1",
      rejectTurnId: "turn-reject",
    });
  });

  it("returns 404 when rejecting a missing draft", async () => {
    const deps = makeDeps({ rejectResult: { status: "not_found" } });

    await expect(
      handleDraftRejectRequest(deps, { threadId, documentId, draftId: "draft-1", userId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("undoes an accepted draft", async () => {
    const deps = makeDeps({
      undoAcceptResult: { status: "reactivated", draftId: "draft-1" },
    });

    await expect(
      handleDraftUndoAcceptRequest(deps, { threadId, documentId, draftId: "draft-1", userId }),
    ).resolves.toEqual({ status: "reactivated", draftId: "draft-1" });
  });

  it.each<[string, DraftUndoDomainResult, number]>([
    ["missing", { status: "not_found" }, 404],
    ["expired", { status: "expired", draftId: "draft-1" }, 410],
    ["conflict", { status: "conflict", draftId: "draft-1" }, 409],
  ])("returns HTTP error for %s undo-accept result", async (_label, undoAcceptResult, statusCode) => {
    const deps = makeDeps({ undoAcceptResult });

    await expect(
      handleDraftUndoAcceptRequest(deps, { threadId, documentId, draftId: "draft-1", userId }),
    ).rejects.toMatchObject({ statusCode });
  });

  it("undoes a rejected draft", async () => {
    const deps = makeDeps({
      undoRejectResult: { status: "reactivated", draftId: "draft-1" },
    });

    await expect(
      handleDraftUndoRejectRequest(deps, { threadId, documentId, draftId: "draft-1", userId }),
    ).resolves.toEqual({ status: "reactivated", draftId: "draft-1" });
  });

  it.each<[string, DraftUndoDomainResult, number]>([
    ["missing", { status: "not_found" }, 404],
    ["expired", { status: "expired", draftId: "draft-1" }, 410],
    ["conflict", { status: "conflict", draftId: "draft-1" }, 409],
  ])("returns HTTP error for %s undo-reject result", async (_label, undoRejectResult, statusCode) => {
    const deps = makeDeps({ undoRejectResult });

    await expect(
      handleDraftUndoRejectRequest(deps, { threadId, documentId, draftId: "draft-1", userId }),
    ).rejects.toMatchObject({ statusCode });
  });

  it("lists reviewable drafts by Work without a thread", async () => {
    const updatedAt = new Date("2026-06-27T12:00:00.000Z");
    const deps = makeDeps({
      reviewableDrafts: [
        {
          ...draft({ id: "draft-1", updatedAt }),
          status: "active" as const,
          documentName: null,
          contextPath: "/nested/chapter.md",
        },
      ],
    });

    await expect(handleWorkDraftListRequest(deps, { projectId, workId, userId })).resolves.toEqual({
      drafts: [
        {
          draftId: "draft-1",
          documentId,
          documentName: null,
          contextPath: "/nested/chapter.md",
          status: "active",
          lastActorTurnId: null,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(deps.documentSync.drafts.listReviewableDraftsByWork).toHaveBeenCalledWith({ workId });
  });

  it("accepts a Work-scoped draft through the producing thread resolved from provenance", async () => {
    const deps = makeDeps({
      resolvedDraftThreadId: "thread-producing",
      acceptResult: {
        status: "applied",
        draftId: "draft-1",
        appliedUpdateSeq: 42,
        acceptTurnId: "turn-accept",
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
    ).resolves.toMatchObject({ status: "applied", acceptTurnId: "turn-accept" });
    expect(deps.documentSync.drafts.resolveDraftThreadId).toHaveBeenCalledWith("draft-1");
    expect(deps.documentSync.drafts.acceptDraft).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-producing", draftId: "draft-1" }),
    );
  });

  it("rejects a Work-scoped draft through the producing thread resolved from provenance", async () => {
    const deps = makeDeps({
      resolvedDraftThreadId: "thread-producing",
      rejectResult: { status: "discarded", draftId: "draft-1", rejectTurnId: "turn-reject" },
    });

    await expect(
      handleWorkDraftRejectRequest(deps, {
        projectId,
        workId,
        documentId,
        draftId: "draft-1",
        userId,
      }),
    ).resolves.toEqual({ status: "discarded", draftId: "draft-1", rejectTurnId: "turn-reject" });
    expect(deps.documentSync.drafts.rejectDraft).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-producing", draftId: "draft-1" }),
    );
  });

  it("applies the strict draft access gate to journal fetch", async () => {
    const deps = makeDeps({ threadUserId: "user-2" });

    await expect(
      handleDraftJournalRequest(deps, {
        threadId,
        documentId,
        draftId: "draft-1",
        revisionToken: 11,
        userId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(deps.documentSync.drafts.getDraftJournal).not.toHaveBeenCalled();
  });

  it("returns 404 for a thread owned by another user", async () => {
    const deps = makeDeps({ threadUserId: "user-2" });

    await expect(
      handleDraftPreviewRequest(deps, { threadId, documentId, userId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ["wrong user document", { hasDocumentAccess: false }],
    ["document outside thread project", { isProjectDocument: false }],
  ])("returns 404 for %s", async (_label, options) => {
    const deps = makeDeps(options);

    await expect(
      handleDraftPreviewRequest(deps, { threadId, documentId, userId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

function makeDeps(
  options: {
    threadUserId?: string;
    hasDocumentAccess?: boolean;
    isProjectDocument?: boolean;
    activeDraft?: Draft;
    acceptResult?: DraftAcceptResult;
    rejectResult?: DraftRejectResult;
    undoAcceptResult?: DraftUndoDomainResult;
    undoRejectResult?: DraftUndoDomainResult;
    reviewableDrafts?: Awaited<
      ReturnType<DraftRouteServices["documentSync"]["drafts"]["listReviewableDraftsByWork"]>
    >;
    resolvedDraftThreadId?: string | null;
    journalResult?: Awaited<
      ReturnType<DraftRouteServices["documentSync"]["drafts"]["getDraftJournal"]>
    >;
  } = {},
): DraftRouteServices {
  return {
    threads: {
      findById: vi.fn(async () => thread({ userId: options.threadUserId ?? userId })),
    },
    threadWorks: {
      findPrimary: vi.fn(async () => ({ workId: threadId as never })),
    },
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
      drafts: {
        getActiveDraft: vi.fn(async () => options.activeDraft ?? null),
        getActiveDraftByWork: vi.fn(async () => options.activeDraft ?? null),
        resolveDraftThreadId: vi.fn(
          async () => (options.resolvedDraftThreadId ?? threadId) as never,
        ),
        previewDraft: vi.fn(async () => ({
          live: "Live",
          markdown: "Preview",
          liveRevisionToken: 7,
          draftRevisionToken: 11,
          recommendedSurface: "inline" as const,
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
        listReviewableDrafts: vi.fn(async () => []),
        listReviewableDraftsByWork: vi.fn(async () => options.reviewableDrafts ?? []),
        getDraftJournal: vi.fn(
          async () => options.journalResult ?? { status: "not_found" as const },
        ),
      },
    },
  };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "draft-1",
    documentId,
    workId,
    status: "active",
    baseLiveUpdateSeq: 1,
    createdDocument: false,
    lastActorTurnId: null,
    appliedAt: null,
    appliedByUserId: null,
    appliedUpdateSeq: null,
    discardedAt: null,
    claimedAt: null,
    claimToken: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    projectId,
    workId: null,
    userId,
    kind: "primary",
    status: "idle",
    title: null,
    currentAgent: null,
    parentThreadId: null,
    rootThreadId: threadId,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
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
