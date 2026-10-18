/**
 * Route core for authenticated draft review over a Work's branch: the list, the preview,
 * and every Apply and Discard command by `itemKey` (contract §3, §4). A command carries a
 * client `commandId`: the route looks it up before grants (so a resend after the branch
 * drained still gets its stored answer), builds the digest envelope, and maps the service's
 * outcome to HTTP. Nothing here decides an effect.
 */

import type { BranchCommandId, BranchId } from "@meridian/contracts";
import {
  BRANCH_COMMAND_CONFLICT_CODE,
  BRANCH_COMMAND_UNKNOWN_CODE,
  type BranchApplyAllRequest,
  BranchCommandIdSchema,
  type BranchCommandKind,
  type BranchCommandObservation,
  type BranchCommandResult,
  type BranchDiscardAllRequest,
  type DocumentDraftHintsResponse,
  type DraftApplyPendingResponse,
  type DraftPreviewResponse,
  MAX_DISCARD_MEMBER_PART_KEYS,
  type ThreadDraftListItem,
  type ThreadDraftListResponse,
} from "@meridian/contracts/branches";
import { isProjectScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import { z } from "zod";
import type { CommandOutcome } from "../domains/collab/contracts.js";
import {
  type BranchCommandEnvelope,
  commandDigest,
} from "../domains/collab/domain/branch-commands.js";
import type { DraftReviewItem } from "../domains/collab/domain/branch-review-items.js";
import { draftItemKey } from "../domains/collab/domain/branch-tree-payload.js";
import { reviewContextLocation } from "../domains/collab/domain/work-branch-review-service.js";
import { type FileGrant, type FileNeed, isFileAccessDenied } from "../domains/file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import type { AppServices } from "./app.js";
import { branchApplyHttpAnswer } from "./branch-apply-http.js";
import {
  documentTarget,
  isFileAccessRefusal,
  requireFileGrant,
  withEditGrants,
} from "./file-access-http.js";
import { throwWorkMutationHttpError } from "./work-http.js";

type BranchRouteServices = {
  projects: Pick<AppServices["projectRepo"], "findById">;
  works: Pick<AppServices["workRepo"], "findById">;
  fileAccess: Pick<
    AppServices["fileAccess"],
    "authorize" | "authorizeAt" | "confirmEdit" | "listAccess"
  >;
  documentSync: Pick<AppServices["documentSync"], "draftReview">;
};

export function selectBranchRouteServices(app: AppServices): BranchRouteServices {
  return {
    projects: app.projectRepo,
    works: app.workRepo,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
  };
}

export async function requireBranchWorkAccess(
  deps: Pick<BranchRouteServices, "projects" | "works">,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<Work> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }
  const work = await deps.works.findById(input.workId);
  if (!work || work.projectId !== input.projectId || work.deletedAt) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }
  return work;
}

// --- Request bodies ----------------------------------------------------------------------------

const Base = {
  branchId: z.string().uuid(),
  itemKey: z.string().max(80),
  commandId: BranchCommandIdSchema,
};
const ApplyItemBody = z.object({
  ...Base,
  locationToken: z.string().max(40).optional(),
  liveTextToken: z.string().max(100).nullable().optional(),
  draftGenerationToken: z.string().max(40).nullable().optional(),
});
const ApplyChangesBody = z.object({
  ...Base,
  operationIds: z.array(z.string().max(200)).min(1).max(500),
  liveRevisionToken: z.string().max(200),
  draftRevisionToken: z.string().max(200),
});
const DiscardBody = z.object({
  ...Base,
  liveRevisionToken: z.string().max(200).optional(),
  draftRevisionToken: z.string().max(200).optional(),
  closureClassIds: z.array(z.string().max(200)).max(500).optional(),
  admissionTokens: z.array(z.string().max(200)).max(500).optional(),
  memberPartKeys: z.array(z.string().max(200)).max(MAX_DISCARD_MEMBER_PART_KEYS).optional(),
  memberPartKeysComplete: z.boolean().optional(),
});

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw createError({ statusCode: 400, message: `Invalid ${what} request` });
  return parsed.data;
}

export const parseDraftApplyItem = (body: unknown) => parseBody(ApplyItemBody, body, "Apply");
export const parseDraftApplySelection = (body: unknown) =>
  parseBody(ApplyChangesBody, body, "Apply changes");
export const parseDraftDiscardSelection = (body: unknown) => {
  const parsed = parseBody(DiscardBody, body, "Discard");
  const perChange = parsed.closureClassIds !== undefined;
  if (
    perChange &&
    (!parsed.liveRevisionToken ||
      !parsed.admissionTokens ||
      !parsed.memberPartKeys ||
      parsed.memberPartKeysComplete === undefined)
  ) {
    throw createError({ statusCode: 400, message: "Invalid Discard request" });
  }
  return parsed;
};

// --- Commands: envelope, lookup, outcome -------------------------------------------------------

type CommandScope = { projectId: ProjectId; workId: WorkId; userId: UserId };

function envelopeOf(
  scope: CommandScope,
  command: {
    commandId: string;
    kind: BranchCommandKind;
    branchId: string;
    selectors: Record<string, string | null>;
    body: unknown;
  },
): BranchCommandEnvelope {
  return {
    commandId: command.commandId as BranchCommandId,
    workId: scope.workId,
    accountId: scope.userId,
    kind: command.kind,
    branchId: command.branchId as BranchId,
    digest: commandDigest({
      accountId: scope.userId,
      projectId: scope.projectId,
      workId: scope.workId,
      kind: command.kind,
      selectors: { branchId: command.branchId, ...command.selectors },
      body: command.body,
    }),
  };
}

export type CommandRouteResult =
  | { httpStatus: 200 | 409; body: BranchCommandResult }
  | { httpStatus: 202; body: DraftApplyPendingResponse };

/**
 * The HTTP meaning of an outcome. Item Apply answers 409 for a held or stale item; a gone
 * item is a 404. A pending or blocked command is the 202 handoff (observe the id); an id
 * that belongs to a different command is a 409 `command_conflict`.
 */
function respond(
  outcome: CommandOutcome,
  command: { branchId: string; commandId: string },
  options: { itemApply?: boolean } = {},
): CommandRouteResult {
  switch (outcome.kind) {
    case "conflict":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          BRANCH_COMMAND_CONFLICT_CODE,
          "That command id was used for a different command",
          false,
        ),
        409,
      );
    case "pending":
    case "blocked":
      return {
        httpStatus: 202,
        body: {
          status: "pending",
          branchId: command.branchId as BranchId,
          commandId: command.commandId as BranchCommandId,
        },
      };
    case "result": {
      const { status } = outcome.result;
      if (options.itemApply && (status === "held" || status === "stale")) {
        return { httpStatus: 409, body: outcome.result };
      }
      if (options.itemApply && status === "gone") {
        throw createError({ statusCode: 404, message: "Draft not found" });
      }
      return { httpStatus: 200, body: outcome.result };
    }
  }
}

/** The stored answer of a command id this Work already knows, looked up before any grant. */
async function recorded(
  deps: BranchRouteServices,
  envelope: BranchCommandEnvelope,
  options?: { itemApply?: boolean },
): Promise<CommandRouteResult | null> {
  const found = await deps.documentSync.draftReview.lookupCommand(envelope);
  if (found.kind === "none") return null;
  const outcome: CommandOutcome =
    found.kind === "done"
      ? { kind: "result", result: found.result }
      : found.kind === "conflict"
        ? { kind: "conflict" }
        : found.kind === "blocked"
          ? { kind: "blocked" }
          : { kind: "pending" };
  return respond(
    outcome,
    { branchId: envelope.branchId ?? "", commandId: envelope.commandId },
    options,
  );
}

/** GET …/branches/commands/:commandId: what a command settled as, never a guess from the list. */
export async function handleBranchCommandObservation(
  deps: BranchRouteServices,
  input: CommandScope & { commandId: string },
): Promise<BranchCommandObservation> {
  await requireBranchWorkAccess(deps, input);
  const id = BranchCommandIdSchema.safeParse(input.commandId);
  if (!id.success) throw createError({ statusCode: 404, message: BRANCH_COMMAND_UNKNOWN_CODE });
  const found = await deps.documentSync.draftReview.lookupCommand({
    commandId: id.data as BranchCommandId,
    workId: input.workId,
    accountId: input.userId,
  });
  switch (found.kind) {
    case "none":
    case "conflict":
      throw createError({ statusCode: 404, message: BRANCH_COMMAND_UNKNOWN_CODE });
    case "pending":
      return { state: "pending" };
    case "blocked":
      return { state: "blocked" };
    case "done":
      return { state: "done", result: found.result };
  }
}

// --- Grants ------------------------------------------------------------------------------------

/**
 * The writer's grant on one draft (file-access §2, §4): preview reads it; Discard edits it;
 * Apply edits it and the live document, so an archived Work's frozen drafts can't be applied
 * (D30).
 */
async function draftGrants<N extends FileNeed>(
  deps: BranchRouteServices,
  input: { projectId: ProjectId; workId: WorkId; documentId: DocumentId; userId: UserId },
  need: N,
  options: { live?: boolean } = {},
): Promise<FileGrant<N>[]> {
  await requireBranchWorkAccess(deps, input);
  const draft = await requireFileGrant(
    deps.fileAccess,
    input.userId,
    { kind: "draft", documentId: input.documentId, workId: input.workId },
    need,
  );
  if (!options.live) return [draft];
  return [
    draft,
    await requireFileGrant(deps.fileAccess, input.userId, documentTarget(input.documentId), need),
  ];
}

/**
 * The edit grants an Apply needs (TM "Authorization", §13.3): the draft's grant on each item,
 * and the live grant on one live readers see. A document deleted live authorizes at its final
 * location's source through the draft's destination (F9). A Discard changes only the draft,
 * so it needs the draft's grants alone (`live: false`).
 */
async function applyGrants(
  deps: BranchRouteServices,
  input: CommandScope & { items: readonly DraftReviewItem[] },
  options: { live: boolean } = { live: true },
): Promise<FileGrant<"edit">[]> {
  const grants: FileGrant<"edit">[] = [];
  for (const item of input.items) {
    if (item.deletedLive) {
      grants.push(await restoreGrant(deps, input, item));
      continue;
    }
    grants.push(
      ...(await draftGrants(deps, { ...input, documentId: item.documentId }, "edit", {
        live: options.live && !item.isNew,
      })),
    );
  }
  return grants;
}

async function restoreGrant<N extends FileNeed = "edit">(
  deps: BranchRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
  item: DraftReviewItem,
  need?: N,
): Promise<FileGrant<N>> {
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
    need,
  );
  if (isFileAccessDenied(grant)) throw createError({ statusCode: 404, message: "Draft not found" });
  return grant;
}

// --- Reads -------------------------------------------------------------------------------------

export async function handleWorkBranchListRequest(
  deps: BranchRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<ThreadDraftListResponse> {
  await requireBranchWorkAccess(deps, input);
  const listed = await deps.documentSync.draftReview.listItems({ workId: input.workId });
  // Readable in the branch's view, where its created documents are (file-access §6); a
  // document deleted live is no longer readable anywhere, but stays the branch's item.
  const readable = listed.branchId
    ? await deps.fileAccess.listAccess(
        { accountId: input.userId },
        listed.items.map((item) => item.documentId),
        {
          branchViews: new Map(
            listed.items.map((item) => [
              item.documentId,
              { kind: "branch" as const, branchId: listed.branchId as BranchId },
            ]),
          ),
        },
      )
    : new Map();
  return {
    items: listed.items
      .filter((item) => readable.has(item.documentId) || item.deletedLive)
      .map((item) => toWireItem(item, listed.threadTitles)),
  };
}

/**
 * Which active branches in the project have changes to one live document, from any view. It
 * authorizes like the review routes: the project owner, and a read grant on the document
 * (a document the writer cannot read gets an empty answer, not a hint of its branches).
 */
export async function handleDocumentDraftHintsRequest(
  deps: BranchRouteServices,
  input: { projectId: ProjectId; documentId: DocumentId; userId: UserId },
): Promise<DocumentDraftHintsResponse> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  const readable = await deps.fileAccess.listAccess({ accountId: input.userId }, [
    input.documentId,
  ]);
  if (!readable.has(input.documentId)) return { items: [] };
  const branches = await deps.documentSync.draftReview.branchesChangingDocument(input);
  return {
    items: branches.map((branch) => ({
      branchId: branch.branchId,
      itemKey: draftItemKey(branch.branchId, input.documentId),
      label: branch.originWorkName,
      originWorkId: branch.originWorkId,
    })),
  };
}

export async function handleWorkDraftPreviewRequest(
  deps: BranchRouteServices,
  input: CommandScope & { documentId: DocumentId; itemKey: string },
): Promise<DraftPreviewResponse> {
  await requireBranchWorkAccess(deps, input);
  const resolved = await deps.documentSync.draftReview.resolveItem(input);
  if (!resolved || resolved.documentId !== input.documentId) {
    return { status: "gone", itemKey: input.itemKey };
  }
  // Review evidence survives live deletion. This read grant cannot authorize rooms,
  // downloads or ordinary file reads, which still check the deleted document.
  if (resolved.item.deletedLive) await restoreGrant(deps, input, resolved.item, "read");
  else await draftGrants(deps, input, "read");
  const preview = await callDraftReview(deps.documentSync.draftReview.preview(input));
  if (preview.status !== "active") return preview;
  const { threadTitles, operations, hunks, item, ...rest } = preview;
  return {
    status: "active",
    branchId: rest.branchId,
    itemKey: rest.itemKey,
    draftGeneration: rest.draftGeneration,
    reviewRoomName: rest.reviewRoomName,
    liveRevisionToken: rest.liveRevisionToken,
    draftRevisionToken: rest.draftRevisionToken,
    item: toWireItem(item, threadTitles),
    operations: operations.map(toWireReviewOperation),
    hunks,
  };
}

// --- Commands ----------------------------------------------------------------------------------

/** Resolves a command's item for a URL document, or null when it is not that document's item. */
async function commandItem(
  deps: BranchRouteServices,
  input: { workId: WorkId; documentId: DocumentId; request: { branchId: string; itemKey: string } },
): Promise<DraftReviewItem | null> {
  const resolved = await deps.documentSync.draftReview.resolveItem({
    workId: input.workId,
    itemKey: input.request.itemKey,
  });
  return resolved &&
    resolved.documentId === input.documentId &&
    resolved.branchId === input.request.branchId
    ? resolved.item
    : null;
}

/** What a command's pre-effect phase decided: refuse it, or run its effect under these grants. */
type PreparedCommand =
  | { refusal: () => CommandRouteResult }
  | { grants: FileGrant<"edit">[]; effect: () => Promise<CommandOutcome> };

/**
 * The one ingress every branch command goes through. After authenticated project and Work
 * access the id is looked up (a resend answers its stored outcome, §4.6); `prepare` then
 * resolves the item and acquires grants, and the grants are confirmed again before the
 * effect. A refusal at either point, a missing item or a grant that has become unavailable,
 * looks the id up once more before it answers (LA-1): a request that lost a race to its own
 * twin gets the winner's outcome, a new effect gets the refusal. Nothing here skips
 * authorization; the grants still gate every effect.
 */
async function commandIngress(
  deps: BranchRouteServices,
  input: CommandScope,
  envelope: BranchCommandEnvelope,
  options: { itemApply?: boolean },
  prepare: () => Promise<PreparedCommand>,
): Promise<CommandRouteResult> {
  await requireBranchWorkAccess(deps, input);
  const replay = await recorded(deps, envelope, options);
  if (replay) return replay;
  const replayOr = async (cause: unknown): Promise<CommandRouteResult> => {
    if (isFileAccessRefusal(cause)) {
      const stored = await recorded(deps, envelope, options);
      if (stored) return stored;
    }
    throw cause;
  };
  let prepared: PreparedCommand;
  try {
    prepared = await prepare();
  } catch (cause) {
    return replayOr(cause);
  }
  if ("refusal" in prepared) return (await recorded(deps, envelope, options)) ?? prepared.refusal();
  let outcome: Awaited<ReturnType<typeof prepared.effect>>;
  try {
    outcome = await withEditGrants(deps.fileAccess, prepared.grants, () =>
      callDraftReview(prepared.effect()),
    );
  } catch (cause) {
    return replayOr(cause);
  }
  return respond(
    outcome,
    { branchId: envelope.branchId ?? "", commandId: envelope.commandId },
    options,
  );
}

/**
 * Item Apply (§4.5): one rendered item through the one Apply path. A held or stale item
 * answers 409, never `applied`; a command id already used answers its stored result.
 */
export async function handleApplyWorkDraftRequest(
  deps: BranchRouteServices,
  input: CommandScope & {
    documentId: DocumentId;
    request: z.infer<typeof ApplyItemBody>;
    signal?: AbortSignal;
  },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "apply_items",
    branchId: request.branchId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, { itemApply: true }, async () => {
    const item = await commandItem(deps, input);
    if (!item) {
      return {
        refusal: () => {
          throw createError({ statusCode: 404, message: "Draft not found" });
        },
      };
    }
    return {
      grants: await applyGrants(deps, { ...input, items: [item] }),
      effect: () =>
        deps.documentSync.draftReview.applyItem({
          workId: input.workId,
          item,
          userId: input.userId,
          envelope,
          tokens: {
            ...(request.locationToken ? { locationToken: request.locationToken } : {}),
            ...(request.liveTextToken !== undefined
              ? { liveTextToken: request.liveTextToken }
              : {}),
            ...(request.draftGenerationToken !== undefined
              ? { draftGenerationToken: request.draftGenerationToken }
              : {}),
          } as never,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
    };
  });
}

/** An item the branch no longer holds, as a 200 body status. */
const goneItem = (request: { branchId: string; itemKey: string }) => (): CommandRouteResult => ({
  httpStatus: 200,
  body: { status: "gone", branchId: request.branchId as BranchId, itemKey: request.itemKey },
});

/** A branch that is not the Work's active one, as a 200 body status. */
const goneBranch = (branchId: BranchId) => (): CommandRouteResult => ({
  httpStatus: 200,
  body: { status: "gone", branchId },
});

/** Per-change Apply: complete server-vended classes; refusals are 200 body statuses. */
export async function handleApplyWorkDraftChangesRequest(
  deps: BranchRouteServices,
  input: CommandScope & {
    documentId: DocumentId;
    request: z.infer<typeof ApplyChangesBody>;
    signal?: AbortSignal;
  },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "apply_changes",
    branchId: request.branchId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, {}, async () => {
    const item = await commandItem(deps, input);
    if (!item) return { refusal: goneItem(request) };
    return {
      grants: await applyGrants(deps, { ...input, items: [item] }),
      effect: () =>
        deps.documentSync.draftReview.applyChanges({
          workId: input.workId,
          itemKey: request.itemKey,
          userId: input.userId,
          envelope,
          selection: {
            kind: "apply",
            operationIds: request.operationIds,
            liveRevisionToken: request.liveRevisionToken,
            draftRevisionToken: request.draftRevisionToken,
          },
          ...(input.signal ? { signal: input.signal } : {}),
        }),
    };
  });
}

/**
 * Apply all (§11.5): the items the dock rendered, one server command. The request's branch
 * must be the Work's active one (else `gone`).
 */
export async function handleApplyAllWorkBranchRequest(
  deps: BranchRouteServices,
  input: CommandScope & { request: BranchApplyAllRequest; signal?: AbortSignal },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "apply_items",
    branchId: request.branchId,
    selectors: {},
    body,
  });
  const branchId = request.branchId as BranchId;
  return commandIngress(deps, input, envelope, {}, async () => {
    const listed = await deps.documentSync.draftReview.items({ workId: input.workId });
    if (listed.branchId !== branchId) return { refusal: goneBranch(branchId) };
    // The grants of what is still an item; one that isn't answers stale from the service.
    const keys = new Set(request.items.map((ref) => ref.itemKey));
    return {
      grants: await applyGrants(deps, {
        ...input,
        items: listed.items.filter((item) => keys.has(item.itemKey)),
      }),
      effect: () =>
        deps.documentSync.draftReview.applyAll({
          workId: input.workId,
          branchId,
          items: request.items,
          userId: input.userId,
          envelope,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
    };
  });
}

/**
 * Item Discard (the whole item through the one kernel, §12.3) or per-change Discard (the
 * clicked classes, §4.1). A document deleted live authorizes through the draft (§13.3).
 */
export async function handleDiscardWorkDraftRequest(
  deps: BranchRouteServices,
  input: CommandScope & {
    documentId: DocumentId;
    request: ReturnType<typeof parseDraftDiscardSelection>;
  },
): Promise<CommandRouteResult> {
  const { request } = input;
  const perChange = request.closureClassIds !== undefined;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: perChange ? "discard_changes" : "discard_items",
    branchId: request.branchId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, {}, async () => {
    const item = await commandItem(deps, input);
    if (!item) return { refusal: goneItem(request) };
    return {
      grants: await applyGrants(deps, { ...input, items: [item] }, { live: false }),
      effect: () =>
        perChange
          ? deps.documentSync.draftReview.discardChanges({
              workId: input.workId,
              itemKey: request.itemKey,
              userId: input.userId,
              envelope,
              selection: {
                kind: "discard",
                closureClassIds: request.closureClassIds ?? [],
                admissionTokens: request.admissionTokens ?? [],
                memberPartKeys: request.memberPartKeys ?? [],
                memberPartKeysComplete: request.memberPartKeysComplete ?? false,
                liveRevisionToken: request.liveRevisionToken ?? "",
                ...(request.draftRevisionToken
                  ? { draftRevisionToken: request.draftRevisionToken }
                  : {}),
              },
            })
          : deps.documentSync.draftReview.discardItem({
              workId: input.workId,
              item,
              userId: input.userId,
              envelope,
            }),
    };
  });
}

/**
 * Discard all (§12.3): the whole branch, one server command; it always closes the branch. The
 * request's branch must be the Work's active one (else `gone`).
 */
export async function handleDiscardAllWorkBranchRequest(
  deps: BranchRouteServices,
  input: CommandScope & { request: BranchDiscardAllRequest },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "discard_branch",
    branchId: request.branchId,
    selectors: {},
    body,
  });
  const branchId = request.branchId as BranchId;
  return commandIngress(deps, input, envelope, {}, async () => {
    const listed = await deps.documentSync.draftReview.listItems({ workId: input.workId });
    if (listed.branchId !== branchId) return { refusal: goneBranch(branchId) };
    return {
      grants: await applyGrants(deps, { ...input, items: listed.items }, { live: false }),
      effect: () =>
        deps.documentSync.draftReview.discardAll({
          workId: input.workId,
          branchId,
          userId: input.userId,
          envelope,
        }),
    };
  });
}

// --- Wire --------------------------------------------------------------------------------------

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

export function toWireItem(
  item: DraftReviewItem,
  threadTitles: ReadonlyMap<string, string>,
): ThreadDraftListItem {
  return {
    branchId: item.branchId,
    itemKey: item.itemKey,
    documentId: item.documentId,
    draftGeneration: item.draftGeneration,
    origin: item.origin,
    isNew: item.isNew,
    binary: item.binary,
    wholeItem: item.wholeItem,
    documentName: item.documentName,
    contextLocation: reviewContextLocation(item.path),
    conflict: item.conflict,
    tokens: item.tokens,
    settling: item.settling,
    actorThreads: item.actorThreadIds.map((threadId) => ({
      threadId,
      title: threadTitles.get(threadId) ?? null,
    })),
    updatedAt: item.updatedAt.toISOString(),
  };
}

async function callDraftReview<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (cause) {
    // Throws the HTTP error of a known Apply failure; the service already answered a
    // staged Apply as pending, so a value here is nothing to return.
    branchApplyHttpAnswer(cause);
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

function throwReadFailure(code: string): never {
  if (code === "not_found") throw createError({ statusCode: 404, message: "Document not found" });
  throw createError({ statusCode: 500, message: "Document markdown is unavailable" });
}
