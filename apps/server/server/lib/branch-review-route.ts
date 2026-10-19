/**
 * Route core for authenticated draft review over a Work's branch: the list, the preview,
 * and every Apply and Discard command by `itemKey` (contract §3, §4). A command carries a
 * client `commandId`: the route looks it up before grants (so a resend after the branch
 * drained still gets its stored answer), builds the digest envelope, and maps the service's
 * outcome to HTTP. Nothing here decides an effect.
 */

import type { BranchCommandId, BranchId } from "@meridian/contracts";
import { draftItemKey } from "@meridian/contracts";
import {
  type ApplyClick,
  type ApplyClickAnswer,
  type ApplyClickObservation,
  BRANCH_COMMAND_CONFLICT_CODE,
  BRANCH_COMMAND_UNKNOWN_CODE,
  BranchCommandIdSchema,
  type BranchCommandKind,
  type BranchCommandObservation,
  type BranchCommandPendingResponse,
  type BranchCommandResult,
  type BranchDiscardAllRequest,
  type DocumentDraftHintsResponse,
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
import { reviewContextLocation } from "../domains/collab/domain/work-branch-review-service.js";
import {
  type FileAccessDenied,
  type FileGrant,
  type FileNeed,
  isFileAccessDenied,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import type { AppServices } from "./app.js";
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
  documentSync: Pick<AppServices["documentSync"], "draftReview" | "roomRemoval">;
};

export function selectBranchRouteServices(app: AppServices): BranchRouteServices {
  return {
    projects: app.projectRepo,
    works: app.workRepo,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
  };
}

async function requireBranchWorkIdentity(
  deps: Pick<BranchRouteServices, "projects" | "works">,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<Work> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }
  const work = await deps.works.findById(input.workId);
  if (!work || work.projectId !== input.projectId) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }
  return work;
}

export async function requireBranchWorkAccess(
  deps: Pick<BranchRouteServices, "projects" | "works">,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<Work> {
  const work = await requireBranchWorkIdentity(deps, input);
  if (work.deletedAt) throw createError({ statusCode: 404, message: "Work not found" });
  return work;
}

// --- Request bodies ----------------------------------------------------------------------------

const Base = {
  branchId: z.string().uuid(),
  itemKey: z.string().max(80),
  commandId: BranchCommandIdSchema,
};
const RangeBody = z
  .strictObject({
    from: z.number().int().nonnegative().safe(),
    to: z.number().int().nonnegative().safe(),
  })
  .refine((range) => range.to >= range.from);
const ApplyClickBody = z.strictObject({
  commandId: BranchCommandIdSchema,
  snapshot: z.string().min(1),
  baseViewDelta: z.array(
    z.strictObject({
      base: RangeBody,
      draft: RangeBody,
      blocks: z.array(z.object({ type: z.string() }).catchall(z.unknown())),
    }),
  ),
  groupIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
});
const DiscardBody = z.strictObject(Base);

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw createError({ statusCode: 400, message: `Invalid ${what} request` });
  return parsed.data;
}

export const parseDraftDiscardItem = (body: unknown) => parseBody(DiscardBody, body, "Discard");

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
  | { httpStatus: 202; body: BranchCommandPendingResponse };

/** Map stored Discard results, pending claims and command-id conflicts to HTTP. */
function respond(
  outcome: CommandOutcome,
  command: { branchId: string; commandId: string },
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
      return {
        httpStatus: 202,
        body: {
          status: "pending",
          branchId: command.branchId as BranchId,
          commandId: command.commandId as BranchCommandId,
        },
      };
    case "result": {
      return { httpStatus: 200, body: outcome.result };
    }
  }
}

/** The stored answer of a command id this Work already knows, looked up before any grant. */
async function recorded(
  deps: BranchRouteServices,
  envelope: BranchCommandEnvelope,
): Promise<CommandRouteResult | null> {
  const found = await deps.documentSync.draftReview.lookupCommand(envelope);
  if (found.kind === "none") return null;
  const outcome: CommandOutcome =
    found.kind === "done"
      ? { kind: "result", result: found.result as BranchCommandResult }
      : found.kind === "conflict"
        ? { kind: "conflict" }
        : { kind: "pending" };
  return respond(outcome, { branchId: envelope.branchId ?? "", commandId: envelope.commandId });
}

/** GET …/branches/commands/:commandId: what a command settled as, never a guess from the list. */
export async function handleBranchCommandObservation(
  deps: BranchRouteServices,
  input: CommandScope & { commandId: string },
): Promise<ApplyClickObservation | BranchCommandObservation> {
  await requireBranchWorkIdentity(deps, input);
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
      return { status: found.kind, commandId: id.data as BranchCommandId };
    case "pending":
      return { status: "pending", commandId: id.data as BranchCommandId };
    case "done":
      return found.commandKind === "apply_click"
        ? (found.result as ApplyClickAnswer)
        : { state: "done", result: found.result as BranchCommandResult };
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
  prepare: () => Promise<PreparedCommand>,
): Promise<CommandRouteResult> {
  await requireBranchWorkAccess(deps, input);
  const replay = await recorded(deps, envelope);
  if (replay) return replay;
  const replayOr = async (cause: unknown): Promise<CommandRouteResult> => {
    if (isFileAccessRefusal(cause)) {
      const stored = await recorded(deps, envelope);
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
  if ("refusal" in prepared) return (await recorded(deps, envelope)) ?? prepared.refusal();
  let outcome: Awaited<ReturnType<typeof prepared.effect>>;
  try {
    outcome = await withEditGrants(deps.fileAccess, prepared.grants, () =>
      callDraftReview(prepared.effect()),
    );
  } catch (cause) {
    return replayOr(cause);
  }
  return respond(outcome, { branchId: envelope.branchId ?? "", commandId: envelope.commandId });
}

/** One immutable Apply click. Until execution lands, a valid click is refused as unavailable. */
export async function handleApplyClickRequest(
  deps: BranchRouteServices,
  input: CommandScope & { documentId: DocumentId; request: unknown },
): Promise<ApplyClickAnswer> {
  const work = await requireBranchWorkIdentity(deps, input);
  const parsedId = BranchCommandIdSchema.safeParse(
    input.request && typeof input.request === "object" && "commandId" in input.request
      ? input.request.commandId
      : undefined,
  );
  if (!parsedId.success) throw createError({ statusCode: 400, message: "Invalid Apply request" });
  const commandId = parsedId.data as BranchCommandId;
  const envelope: BranchCommandEnvelope = {
    commandId,
    accountId: input.userId,
    workId: input.workId,
    kind: "apply_click",
    branchId: null,
    digest: commandDigest({
      accountId: input.userId,
      projectId: input.projectId,
      workId: input.workId,
      kind: "apply_click",
      selectors: { documentId: input.documentId },
      body: input.request,
    }),
  };
  const lookup = async (): Promise<ApplyClickAnswer | null> => {
    const found = await deps.documentSync.draftReview.lookupCommand(envelope);
    if (found.kind === "none") return null;
    if (found.kind === "done")
      return found.commandKind === "apply_click"
        ? (found.result as ApplyClickAnswer)
        : { status: "conflict", commandId };
    return { status: found.kind === "conflict" ? "conflict" : "pending", commandId };
  };
  const recorded = await lookup();
  if (recorded) return recorded;
  const refuse = async (
    reason: import("@meridian/contracts/branches").ApplyClickRefusalReason,
  ): Promise<ApplyClickAnswer> => (await lookup()) ?? { status: "refused", commandId, reason };
  async function deniedAnswer(grant: FileAccessDenied): Promise<ApplyClickAnswer> {
    // A known removed identity is a terminal room outcome, not an edit denial.
    // Never expose its record to a different owner or project.
    if (
      grant.facts?.deleted &&
      grant.facts.ownerAccountId === input.userId &&
      grant.facts.projectId === input.projectId
    ) {
      const removed = await deps.documentSync.roomRemoval({ documentId: input.documentId });
      if (removed)
        return (await lookup()) ?? { status: "closed", commandId, removal: removed.removal };
    }
    return refuse(
      grant.facts?.branchWork?.deleted || grant.facts?.ownerWork?.deleted
        ? "work_deleted"
        : grant.reason === "work_archived"
          ? "work_archived"
          : "not_found",
    );
  }
  const parsed = ApplyClickBody.safeParse(input.request);
  if (!parsed.success) return refuse("malformed");
  if (work.deletedAt) return refuse("work_deleted");
  if (work.archivedAt) return refuse("work_archived");
  const item = await deps.documentSync.draftReview.resolveItemByDocument({
    workId: input.workId,
    documentId: input.documentId,
  });
  const grants: FileGrant<"edit">[] = [];
  for (const target of [
    { kind: "draft" as const, documentId: input.documentId, workId: input.workId },
    ...(item?.item.isNew ? [] : [documentTarget(input.documentId)]),
  ]) {
    const grant = await deps.fileAccess.authorize({ accountId: input.userId }, target, "edit");
    if (isFileAccessDenied(grant)) return deniedAnswer(grant);
    grants.push(grant);
  }
  const result = await runWithEditGrants(deps.fileAccess, grants, () =>
    deps.documentSync.draftReview.applyClick({
      workId: input.workId,
      documentId: input.documentId,
      request: parsed.data as ApplyClick,
      envelope,
    }),
  );
  if (result.ok) return result.value;
  const denial = result.refusal.refused[0];
  return denial ? deniedAnswer(denial) : refuse("not_found");
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

/**
 * Item Discard (the whole item through the one kernel, §12.3). A document deleted live authorizes through the draft (§13.3).
 */
export async function handleDiscardWorkDraftRequest(
  deps: BranchRouteServices,
  input: CommandScope & {
    documentId: DocumentId;
    request: ReturnType<typeof parseDraftDiscardItem>;
  },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "discard_items",
    branchId: request.branchId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, async () => {
    const item = await commandItem(deps, input);
    if (!item) return { refusal: goneItem(request) };
    return {
      grants: await applyGrants(deps, { ...input, items: [item] }, { live: false }),
      effect: () =>
        deps.documentSync.draftReview.discardItem({
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
  return commandIngress(deps, input, envelope, async () => {
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

export function toWireItem(
  item: DraftReviewItem,
  threadTitles: ReadonlyMap<string, string>,
): ThreadDraftListItem {
  return {
    branchId: item.branchId,
    itemKey: item.itemKey,
    documentId: item.documentId,
    hasDraft: item.hasDraft,
    origin: item.origin,
    isNew: item.isNew,
    binary: item.binary,
    wholeItem: item.wholeItem,
    documentName: item.documentName,
    contextLocation: reviewContextLocation(item.path),
    conflict: item.conflict,
    tokens: item.tokens,
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
