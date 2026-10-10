/**
 * Route core for authenticated AI draft review over a Work's draft: the list (legacy
 * branch items plus the additive `items`), preview, Apply (per document and Apply all,
 * one publication each) and Discard. Wire changes are additive (F14, contract §13.4).
 */

import type { DraftId } from "@meridian/contracts";
import { isProjectScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  DraftApplyAllRequest,
  DraftApplyAllResponse,
  DraftApplyItemResult,
  DraftApplyNote,
  DraftApplyRefusalBody,
  DraftApplyResponse,
  DraftApplyResponseAdditions,
  DraftApplyTokens,
  DraftDiscardResponse,
  DraftListResponseAdditions,
  DraftPreviewAdditions,
  DraftPreviewResponse,
  DraftReviewItemWire,
  ThreadDraftListItem,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { PublicationLeasesChangedError } from "../domains/collab/domain/branch-push-transition.js";
import {
  DraftLinkRegistrationFailedError,
  DuplicateApplyItemError,
} from "../domains/collab/domain/draft-publication.js";
import type { DraftReviewItem } from "../domains/collab/domain/draft-review-items.js";
import { type FileGrant, type FileNeed, isFileAccessDenied } from "../domains/file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import type { AppServices } from "./app.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { throwWorkMutationHttpError } from "./work-http.js";

type DraftRouteServices = {
  projects: Pick<AppServices["projectRepo"], "findById">;
  works: Pick<AppServices["workRepo"], "findById">;
  fileAccess: Pick<
    AppServices["fileAccess"],
    "authorize" | "authorizeAt" | "confirmEdit" | "listAccess"
  >;
  documentSync: Pick<AppServices["documentSync"], "draftReview">;
};

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    projects: app.projectRepo,
    works: app.workRepo,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
  };
}

export function scheduleDraftCatalogRefresh(
  app: Pick<AppServices, "contextCatalogRefresh">,
  projectId: ProjectId,
  waitUntil: (task: Promise<void>) => void,
): void {
  waitUntil(app.contextCatalogRefresh.refreshProjectDocuments(projectId));
}

export async function requireDraftWorkAccess(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<void> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  const work = await deps.works.findById(input.workId);
  if (!work || work.projectId !== input.projectId) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
}

/**
 * The writer's grant on one draft (file-access §2, §4): preview reads it;
 * Discard edits it; Apply edits it and the live document, so an archived
 * Work's frozen draft can't be applied (D30).
 */
async function draftGrants<N extends FileNeed>(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; documentId: DocumentId; userId: UserId },
  need: N,
  options: { live?: boolean } = {},
): Promise<FileGrant<N>[]> {
  await requireDraftWorkAccess(deps, input);
  const draft = await requireFileGrant(
    deps.fileAccess,
    input.userId,
    { kind: "draft", documentId: input.documentId, workId: input.workId },
    need,
  );
  if (draft.facts.projectId !== input.projectId) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  if (!options.live) return [draft];
  return [
    draft,
    await requireFileGrant(deps.fileAccess, input.userId, documentTarget(input.documentId), need),
  ];
}

export async function handleWorkDraftListRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<ThreadDraftListResponse & DraftListResponseAdditions> {
  await requireDraftWorkAccess(deps, input);
  const listed = await deps.documentSync.draftReview.listItems({ workId: input.workId });
  // Readable in the draft's view, where its created documents are (file-access §6); a
  // document deleted live is no longer readable anywhere, but stays the draft's item.
  const readable = listed.draftId
    ? await deps.fileAccess.listAccess(
        { accountId: input.userId },
        listed.items.map((item) => item.documentId),
        {
          draftViews: new Map(
            listed.items.map((item) => [
              item.documentId,
              { kind: "draft" as const, draftId: listed.draftId as DraftId },
            ]),
          ),
        },
      )
    : new Map();
  const items = listed.items.filter((item) => readable.has(item.documentId) || item.deletedLive);
  const shown = new Set(items.map((item) => item.documentId));
  return {
    drafts: listed.drafts
      .filter((draft) => shown.has(draft.documentId))
      .map((draft) => serializeThreadDraft(draft, undefined)),
    items: items.map(toWireItem),
  };
}

export async function handleWorkDraftPreviewRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
  },
): Promise<DraftPreviewResponse & Partial<DraftPreviewAdditions>> {
  await draftGrants(deps, input, "read");
  const preview = await callDraftReview(deps.documentSync.draftReview.preview(input));
  if (preview.status === "gone") return preview;

  const base = {
    status: "active" as const,
    draftId: preview.draftId,
    reviewRoomName: preview.reviewRoomName,
    live: preview.live,
    preview: preview.markdown,
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
    ...(preview.notice ? { notice: preview.notice } : {}),
    ...(preview.isNewDocument ? { isNewDocument: true } : {}),
    ...(preview.item ? { item: toWireItem(preview.item) } : {}),
  };
  return {
    ...base,
    inlineModelPresent: true,
    operations: preview.operations.map(toWireReviewOperation),
    hunks: preview.hunks,
  };
}

/**
 * The legacy per-document Apply (§11.4): one rendered item through the one publication.
 * Optional additive tokens; without them nothing is compared (as before). A held or
 * stale item answers 409, never `applied`.
 */
export async function handleApplyWorkDraftRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    tokens?: DraftApplyTokens;
    signal?: AbortSignal;
  },
): Promise<DraftApplyRouteResult> {
  await requireDraftWorkAccess(deps, input);
  // The branch the request names must be the Work's active draft's branch on the document.
  const found = await deps.documentSync.draftReview.item({
    workId: input.workId,
    documentId: input.documentId,
  });
  const item = found?.item.draftBranchId === input.draftId ? found.item : null;
  if (!item) throw createError({ statusCode: 404, message: "Draft not found" });
  const grants = await applyGrants(deps, { ...input, items: [item] });
  const result = await withEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(
      deps.documentSync.draftReview.applyWorkDraft({
        workId: input.workId,
        item,
        userId: input.userId,
        ...(input.tokens ? { tokens: input.tokens } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ),
  );
  switch (result.status) {
    case "applied":
      return {
        httpStatus: 200,
        body: { status: "applied", draftId: result.draftId, item: toWireApplied(result.item) },
      };
    case "held":
      return {
        httpStatus: 409,
        body: { status: "held", draftId: result.draftId, reason: result.reason },
      };
    case "stale":
      return { httpStatus: 409, body: { status: "stale", draftId: result.draftId } };
    case "not_found":
      throw createError({ statusCode: 404, message: "Draft not found" });
  }
}

/** The per-document Apply's answer: 200 applied, or 409 held or stale (F14: never `applied`). */
export type DraftApplyRouteResult =
  | { httpStatus: 200; body: DraftApplyResponse & DraftApplyResponseAdditions }
  | { httpStatus: 409; body: DraftApplyRefusalBody };

/**
 * Apply all (§11.5): the items the dock rendered, one server command. The request's
 * draft must be the Work's active one (else `gone`); every status is a 200.
 */
export async function handleApplyAllWorkDraftRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    userId: UserId;
    request: DraftApplyAllRequest;
    signal?: AbortSignal;
  },
): Promise<DraftApplyAllResponse> {
  await requireDraftWorkAccess(deps, input);
  const listed = await deps.documentSync.draftReview.items({ workId: input.workId });
  const draftId = input.request.draftId as DraftId;
  if (listed.draftId !== draftId) return { status: "gone", draftId };
  // The grants of what is still an item; one that isn't answers stale from the service.
  const keys = new Set(input.request.items.map((ref) => ref.itemKey));
  const grants = await applyGrants(deps, {
    ...input,
    items: listed.items.filter((item) => keys.has(item.itemKey)),
  });
  const result = await withEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(
      deps.documentSync.draftReview.applyAll({
        workId: input.workId,
        draftId,
        items: input.request.items,
        userId: input.userId,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ),
  );
  switch (result.status) {
    case "gone":
      return { status: "gone", draftId: result.draftId };
    case "stale":
      return { status: "stale", draftId: result.draftId, staleItemKeys: [...result.staleItemKeys] };
    case "applied":
      return {
        status: "applied",
        draftId: result.draftId,
        draftClosed: result.draftClosed,
        items: result.items.map((item) =>
          item.status === "applied" ? toWireApplied(item) : { ...item },
        ),
      };
  }
}

/**
 * The edit grants an Apply needs (TM "Authorization", §13.3): the draft's grant on each
 * item (its location in the draft is where it lands), and the live grant on one live
 * readers see. A document deleted live isn't in the draft's view: it authorizes at its
 * final location's source through the draft's destination (F9).
 */
async function applyGrants(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    userId: UserId;
    items: readonly DraftReviewItem[];
  },
): Promise<FileGrant<"edit">[]> {
  const grants: FileGrant<"edit">[] = [];
  for (const item of input.items) {
    if (item.deletedLive) {
      grants.push(await restoreGrant(deps, input, item));
      continue;
    }
    grants.push(
      ...(await draftGrants(deps, { ...input, documentId: item.documentId }, "edit", {
        live: !item.isNew,
      })),
    );
  }
  return grants;
}

async function restoreGrant(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
  item: DraftReviewItem,
): Promise<FileGrant<"edit">> {
  const parsed = item.path ? parseUnifiedContextUri(item.path) : null;
  if (!parsed?.ok || !isProjectScopedScheme(parsed.value.scheme)) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  const grant = await deps.fileAccess.authorizeAt(
    { accountId: input.userId },
    {
      kind: "container",
      scheme: parsed.value.scheme,
      owner: { scope: "project", projectId: input.projectId },
    },
    { kind: "draft", workId: input.workId, workSlug: null },
  );
  if (isFileAccessDenied(grant)) throw createError({ statusCode: 404, message: "Draft not found" });
  return grant;
}

export async function handleDiscardWorkDraftRequest(
  deps: DraftRouteServices,
  input: {
    projectId: ProjectId;
    workId: WorkId;
    documentId: DocumentId;
    draftId: string;
    userId: UserId;
    operationIds?: string[];
  },
): Promise<DraftDiscardResponse> {
  const grants = await draftGrants(deps, input, "edit");
  return withEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(deps.documentSync.draftReview.discardWorkDraft(input)),
  );
}

function toWireReviewOperation<T extends { discardUpdateIds?: unknown; sourceUpdateIds?: unknown }>(
  operation: T,
) {
  const {
    discardUpdateIds: _discardUpdateIds,
    sourceUpdateIds: _sourceUpdateIds,
    ...wire
  } = operation;
  return wire;
}

async function callDraftReview<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof DraftLinkRegistrationFailedError) {
      throw createError({ statusCode: 503, message: cause.message });
    }
    if (cause instanceof DuplicateApplyItemError) {
      throw createError({ statusCode: 400, message: cause.message });
    }
    // The draft kept growing past the call's bounded retries: the staged batch is with
    // recovery, which finishes it; nothing failed, so this is no 500 (F22).
    if (cause instanceof PublicationLeasesChangedError) {
      throw createError({
        statusCode: 503,
        message: "The draft kept changing while it was applied; it finishes in the background.",
      });
    }
    if (cause instanceof Error && cause.message.startsWith("read_failed:")) {
      throwReadFailure(cause.message.slice("read_failed:".length));
    }
    if (cause instanceof WorkLifecycleUnavailableError) throwWorkMutationHttpError(cause);
    if (cause instanceof Error && cause.message === "draft_not_found") {
      throw createError({ statusCode: 404, message: "Draft not found" });
    }
    throw cause;
  }
}

function toWireItem(item: DraftReviewItem): DraftReviewItemWire {
  return {
    draftId: item.draftId,
    itemKey: item.itemKey,
    documentId: item.documentId,
    draftBranchId: item.draftBranchId,
    origin: item.origin,
    isNew: item.isNew,
    binary: item.binary,
    documentName: item.documentName,
    path: item.path,
    livePath: item.livePath,
    conflict: item.conflict,
    locationToken: item.tokens.locationToken,
    liveTextToken: item.tokens.liveTextToken,
    branchGenerationToken: item.tokens.branchGenerationToken,
  };
}

function toWireApplied(item: {
  itemKey: string;
  status: "applied";
  notes: readonly DraftApplyNote[];
}): Extract<DraftApplyItemResult, { status: "applied" }> {
  return { itemKey: item.itemKey, status: "applied", notes: [...item.notes] };
}

function serializeThreadDraft(
  draft: {
    draftId: string;
    documentId: string;
    documentName: string | null;
    contextPath: string | null;
    status: "active";
    lastActorTurnId: string | null;
    updatedAt: Date;
    wordsAdded?: number | null;
    wordsRemoved?: number | null;
    createdDocument?: boolean;
  },
  lifecycle?: {
    proposedOperationCount: number | null;
  },
): ThreadDraftListItem {
  return {
    draftId: draft.draftId,
    documentId: draft.documentId,
    documentName: draft.documentName,
    contextPath: draft.contextPath,
    status: draft.status,
    lastActorTurnId: draft.lastActorTurnId,
    updatedAt: draft.updatedAt.toISOString(),
    proposedOperationCount: lifecycle?.proposedOperationCount ?? null,
    wordsAdded: draft.wordsAdded ?? null,
    wordsRemoved: draft.wordsRemoved ?? null,
    ...(draft.createdDocument ? { isNewDocument: true } : {}),
  };
}

function throwReadFailure(code: string): never {
  if (code === "not_found") throw createError({ statusCode: 404, message: "Document not found" });
  throw createError({ statusCode: 500, message: "Document markdown is unavailable" });
}
