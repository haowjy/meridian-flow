/**
 * Route core for authenticated AI draft review over a Work's draft: the list, the preview,
 * and every Apply and Discard command by `itemKey` (contract §3, §4). A command carries a
 * client `commandId`: the route looks it up before grants (so a resend after the draft
 * drained still gets its stored answer), builds the digest envelope, and maps the service's
 * outcome to HTTP. Nothing here decides an effect.
 */

import type { DraftCommandId, DraftId } from "@meridian/contracts";
import { isProjectScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  type DocumentDraftHintsResponse,
  DRAFT_COMMAND_CONFLICT_CODE,
  DRAFT_COMMAND_UNKNOWN_CODE,
  type DraftApplyAllBody,
  DraftApplyAllBodySchema,
  type DraftApplyChangesBody,
  DraftApplyChangesBodySchema,
  type DraftApplyItemBody,
  DraftApplyItemBodySchema,
  type DraftApplyPendingResponse,
  type DraftAttribution,
  DraftCommandIdSchema,
  type DraftCommandKind,
  type DraftCommandOutcome,
  type DraftDiscardAllBody,
  DraftDiscardAllBodySchema,
  type DraftItemDiscardBody,
  DraftItemDiscardBodySchema,
  type DraftItemMeta,
  type ThreadDraftFilesResponse,
  type ThreadDraftListItem,
  type ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { createError } from "nitro/h3";
import type { z } from "zod";
import type { CommandOutcome } from "../domains/collab/contracts.js";
import {
  commandDigest,
  type DraftCommandEnvelope,
} from "../domains/collab/domain/draft-commands.js";
import type { DraftReviewItem } from "../domains/collab/domain/draft-review-items.js";
import { draftItemKey } from "../domains/collab/domain/draft-tree-payload.js";
import { reviewContextLocation } from "../domains/collab/domain/work-draft-review-service.js";
import { type FileGrant, type FileNeed, isFileAccessDenied } from "../domains/file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import type { AppServices } from "./app.js";
import { draftPublicationHttpAnswer } from "./draft-publication-http.js";
import {
  documentTarget,
  isFileAccessRefusal,
  requireFileGrant,
  withEditGrants,
} from "./file-access-http.js";
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

/** What observing a command answers: `done.result` is the outcome its 2xx/4xx body carried. */
export type DraftCommandObservationBody =
  | { state: "pending" }
  | { state: "done"; result: DraftCommandOutcome }
  | { state: "blocked" };

export function selectDraftRouteServices(app: AppServices): DraftRouteServices {
  return {
    projects: app.projectRepo,
    works: app.workRepo,
    fileAccess: app.fileAccess,
    documentSync: app.documentSync,
  };
}

export async function requireDraftWorkAccess(
  deps: Pick<DraftRouteServices, "projects" | "works">,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<Work> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  const work = await deps.works.findById(input.workId);
  if (!work || work.projectId !== input.projectId || work.deletedAt) {
    throw createError({ statusCode: 404, message: "Draft not found" });
  }
  return work;
}

// --- Request bodies ----------------------------------------------------------------------------
// Every body is strict (contracts `drafts/review.ts`): an unknown field answers 400, so an old tab's
// per-change Discard can never be read as an item Discard that closes the whole item.

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw createError({ statusCode: 400, message: `Invalid ${what} request` });
  return parsed.data;
}

export const parseDraftApplyItem = (body: unknown) =>
  parseBody(DraftApplyItemBodySchema, body, "Apply");
export const parseDraftApplyChanges = (body: unknown) =>
  parseBody(DraftApplyChangesBodySchema, body, "Apply changes");
export const parseDraftApplyAll = (body: unknown) =>
  parseBody(DraftApplyAllBodySchema, body, "Apply all");
export const parseDraftItemDiscard = (body: unknown) =>
  parseBody(DraftItemDiscardBodySchema, body, "Discard");
export const parseDraftDiscardAll = (body: unknown) =>
  parseBody(DraftDiscardAllBodySchema, body, "Discard all");

// --- Commands: envelope, lookup, outcome -------------------------------------------------------

type CommandScope = { projectId: ProjectId; workId: WorkId; userId: UserId };

function envelopeOf(
  scope: CommandScope,
  command: {
    commandId: string;
    kind: DraftCommandKind;
    draftId: string;
    selectors: Record<string, string | null>;
    body: unknown;
  },
): DraftCommandEnvelope {
  return {
    commandId: command.commandId as DraftCommandId,
    workId: scope.workId,
    accountId: scope.userId,
    kind: command.kind,
    draftId: command.draftId as DraftId,
    digest: commandDigest({
      accountId: scope.userId,
      projectId: scope.projectId,
      workId: scope.workId,
      kind: command.kind,
      selectors: { draftId: command.draftId, ...command.selectors },
      body: command.body,
    }),
  };
}

export type CommandRouteResult =
  | { httpStatus: 200 | 404 | 409; body: DraftCommandOutcome }
  | { httpStatus: 202; body: DraftApplyPendingResponse };

/** The item Apply results that answer 409: nothing reached live and the item is unchanged. */
const ITEM_APPLY_REFUSALS: ReadonlySet<string> = new Set([
  "held",
  "not_found",
  "failed",
  "stale",
  "whole_item",
]);

/**
 * The HTTP meaning of an outcome. Item Apply answers 409 for a held, stale, unfound or failed item
 * (and a change of a whole item); a gone item is a 404. A pending or blocked command is the 202 handoff (observe the id); an id
 * that belongs to a different command is a 409 `command_conflict`.
 */
function respond(
  outcome: CommandOutcome,
  command: { draftId: string; commandId: string },
  options: { itemApply?: boolean } = {},
): CommandRouteResult {
  switch (outcome.kind) {
    case "conflict":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          DRAFT_COMMAND_CONFLICT_CODE,
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
          draftId: command.draftId as DraftId,
          commandId: command.commandId as DraftCommandId,
        },
      };
    case "result": {
      const { status } = outcome.result;
      if (options.itemApply && ITEM_APPLY_REFUSALS.has(status)) {
        return { httpStatus: 409, body: outcome.result };
      }
      // The same outcome JSON observation returns (§1.2), under the 404 an old client expects.
      if (options.itemApply && status === "gone") return { httpStatus: 404, body: outcome.result };
      return { httpStatus: 200, body: outcome.result };
    }
  }
}

/** The stored answer of a command id this Work already knows, looked up before any grant. */
async function recorded(
  deps: DraftRouteServices,
  envelope: DraftCommandEnvelope,
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
    { draftId: envelope.draftId ?? "", commandId: envelope.commandId },
    options,
  );
}

/** GET …/drafts/commands/:commandId: what a command settled as, never a guess from the list. */
export async function handleDraftCommandObservation(
  deps: DraftRouteServices,
  input: CommandScope & { commandId: string },
): Promise<DraftCommandObservationBody> {
  await requireDraftWorkAccess(deps, input);
  const id = DraftCommandIdSchema.safeParse(input.commandId);
  if (!id.success) throw createError({ statusCode: 404, message: DRAFT_COMMAND_UNKNOWN_CODE });
  const found = await deps.documentSync.draftReview.lookupCommand({
    commandId: id.data as DraftCommandId,
    workId: input.workId,
    accountId: input.userId,
  });
  switch (found.kind) {
    case "none":
    case "conflict":
      throw createError({ statusCode: 404, message: DRAFT_COMMAND_UNKNOWN_CODE });
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
 * Apply edits it and the live document, so an archived Work's frozen draft can't be applied
 * (D30).
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
  deps: DraftRouteServices,
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
  deps: DraftRouteServices,
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

export async function handleWorkDraftListRequest(
  deps: DraftRouteServices,
  input: { projectId: ProjectId; workId: WorkId; userId: UserId },
): Promise<ThreadDraftListResponse> {
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
  return {
    items: listed.items
      .filter((item) => readable.has(item.documentId) || item.deletedLive)
      .map((item) => toWireItem(item, listed.threadTitles)),
  };
}

/**
 * Which active drafts in the project have changes to one live document, from any view. It
 * authorizes like the review routes: the project owner, and a read grant on the document
 * (a document the writer cannot read gets an empty answer, not a hint of its drafts).
 */
export async function handleDocumentDraftHintsRequest(
  deps: DraftRouteServices,
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
  const drafts = await deps.documentSync.draftReview.draftsChangingDocument(input);
  return {
    items: drafts.map((draft) => ({
      draftId: draft.draftId,
      itemKey: draftItemKey(draft.draftId, input.documentId),
      label: draft.originWorkName,
      originWorkId: draft.originWorkId,
    })),
  };
}

/**
 * An item's existence and where to open it (§3.2): any addressable item, listed or not. A 200
 * means the item exists; a 404 `gone` means it is closed. Read failures are HTTP errors.
 */
export async function handleWorkDraftItemMetaRequest(
  deps: DraftRouteServices,
  input: CommandScope & { documentId: DocumentId; itemKey: string },
): Promise<DraftItemMeta> {
  await requireDraftWorkAccess(deps, input);
  const gone = () =>
    throwHttpInterrupt(meridianErrorFromSystem("gone", "That draft item is closed", false), 404);
  const resolved = await deps.documentSync.draftReview.resolveItem(input);
  if (!resolved || resolved.documentId !== input.documentId) return gone();
  // Review evidence survives live deletion. This read grant cannot authorize rooms,
  // downloads or ordinary file reads, which still check the deleted document.
  if (resolved.item.deletedLive) await restoreGrant(deps, input, resolved.item, "read");
  else await draftGrants(deps, input, "read");
  const meta = await callDraftReview(deps.documentSync.draftReview.itemMeta(input));
  return "status" in meta ? gone() : meta;
}

/**
 * The chat-name hint for one item (Q3): the AI edits pending in its room, as item ranges the
 * browser matches. Authorized like the item's metadata; the hint never gates a change.
 */
export async function handleDraftAttributionRequest(
  deps: DraftRouteServices,
  input: CommandScope & { documentId: DocumentId; itemKey: string },
): Promise<DraftAttribution> {
  await requireDraftWorkAccess(deps, input);
  const resolved = await deps.documentSync.draftReview.resolveItem(input);
  if (!resolved || resolved.documentId !== input.documentId) {
    throwHttpInterrupt(meridianErrorFromSystem("gone", "That draft item is closed", false), 404);
  }
  await draftGrants(deps, input, "read");
  const attribution = await deps.documentSync.draftReview.attribution(input);
  if (!attribution) {
    throwHttpInterrupt(meridianErrorFromSystem("gone", "That draft item is closed", false), 404);
  }
  return attribution;
}

/** The chat strip's collapsed list: the listed items of the chat's Work with this chat's AI edits. */
export async function handleThreadDraftFilesRequest(
  deps: DraftRouteServices & {
    threads: Pick<AppServices["repos"]["threads"], "findById">;
    threadWorks: Pick<AppServices["repos"]["threadWorks"], "findPrimary">;
  },
  input: { threadId: ThreadId; userId: UserId },
): Promise<ThreadDraftFilesResponse> {
  const thread = await deps.threads.findById(input.threadId);
  if (!thread || thread.userId !== input.userId)
    throw createError({ statusCode: 404, message: "Thread not found" });
  const primary = await deps.threadWorks.findPrimary(input.threadId);
  const work = primary ? await deps.works.findById(primary.workId) : null;
  if (!work) return { drafts: [] };
  const { items } = await handleWorkDraftListRequest(deps, {
    projectId: work.projectId,
    workId: work.id,
    userId: input.userId,
  });
  return {
    drafts: items.filter((item) =>
      item.actorThreads.some((actor) => actor.threadId === input.threadId),
    ),
  };
}

// --- Commands ----------------------------------------------------------------------------------

/** Resolves a command's item for a URL document, or null when it is not that document's item. */
async function commandItem(
  deps: DraftRouteServices,
  input: { workId: WorkId; documentId: DocumentId; request: { draftId: string; itemKey: string } },
): Promise<DraftReviewItem | null> {
  const resolved = await deps.documentSync.draftReview.resolveItem({
    workId: input.workId,
    itemKey: input.request.itemKey,
  });
  return resolved &&
    resolved.documentId === input.documentId &&
    resolved.draftId === input.request.draftId
    ? resolved.item
    : null;
}

/** What a command's pre-effect phase decided: refuse it, or run its effect under these grants. */
type PreparedCommand =
  | { refusal: DraftCommandOutcome }
  | { grants: FileGrant<"edit">[]; effect: () => Promise<CommandOutcome> };

/**
 * The one ingress every draft command goes through. After authenticated project and Work
 * access the id is looked up (a resend answers its stored outcome, §4.6); `prepare` then
 * resolves the item and acquires grants, and the grants are confirmed again before the
 * effect. A refusal at either point, a missing item or a grant that has become unavailable,
 * looks the id up once more before it answers (LA-1): a request that lost a race to its own
 * twin gets the winner's outcome, a new effect gets the refusal. Nothing here skips
 * authorization; the grants still gate every effect.
 */
async function commandIngress(
  deps: DraftRouteServices,
  input: CommandScope,
  envelope: DraftCommandEnvelope,
  options: { itemApply?: boolean },
  prepare: () => Promise<PreparedCommand>,
): Promise<CommandRouteResult> {
  await requireDraftWorkAccess(deps, input);
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
  if ("refusal" in prepared) {
    // Authorized and terminal: recorded, so a resend answers this and never meets fresh state (§1.4).
    const stored = await deps.documentSync.draftReview.refuse({
      envelope,
      result: prepared.refusal,
    });
    return respond(
      stored,
      { draftId: envelope.draftId ?? "", commandId: envelope.commandId },
      options,
    );
  }
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
    { draftId: envelope.draftId ?? "", commandId: envelope.commandId },
    options,
  );
}

/**
 * Item Apply: the whole item (or what the snapshot of its open review names) through the one
 * publication. A held, stale, unfound or failed item answers 409, never `applied`; a command id
 * already used answers its stored result.
 */
export async function handleApplyWorkDraftRequest(
  deps: DraftRouteServices,
  input: CommandScope & {
    documentId: DocumentId;
    request: DraftApplyItemBody;
    signal?: AbortSignal;
  },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "apply_items",
    draftId: request.draftId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, { itemApply: true }, async () => {
    const item = await commandItem(deps, input);
    if (!item) {
      return {
        refusal: {
          status: "gone",
          draftId: request.draftId as DraftId,
          itemKey: request.itemKey,
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
          ...(request.locationToken ? { locationToken: request.locationToken } : {}),
          ...(request.snapshot ? { snapshot: request.snapshot } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
    };
  });
}

/** An item the draft no longer holds, as a 200 body status. */
const goneItem = (request: { draftId: string; itemKey: string }): DraftCommandOutcome => ({
  status: "gone",
  draftId: request.draftId as DraftId,
  itemKey: request.itemKey,
});

/** A draft that is not the Work's active one, as a 200 body status. */
const goneDraft = (draftId: DraftId): DraftCommandOutcome => ({ status: "gone", draftId });

/** Apply the named changes of one item, as projected in the snapshot's frame. */
export async function handleApplyWorkDraftChangesRequest(
  deps: DraftRouteServices,
  input: CommandScope & {
    documentId: DocumentId;
    request: DraftApplyChangesBody;
    signal?: AbortSignal;
  },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "apply_changes",
    draftId: request.draftId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, { itemApply: true }, async () => {
    const item = await commandItem(deps, input);
    if (!item) {
      return {
        refusal: {
          status: "gone",
          draftId: request.draftId as DraftId,
          itemKey: request.itemKey,
        },
      };
    }
    return {
      grants: await applyGrants(deps, { ...input, items: [item] }),
      effect: () =>
        deps.documentSync.draftReview.applyChanges({
          workId: input.workId,
          item,
          userId: input.userId,
          envelope,
          changeIds: request.changeIds,
          snapshot: request.snapshot,
          ...(request.locationToken ? { locationToken: request.locationToken } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
    };
  });
}

/**
 * Apply all (§11.5): the items the dock rendered, one server command. The request's draft
 * must be the Work's active one (else `gone`).
 */
export async function handleApplyAllWorkDraftRequest(
  deps: DraftRouteServices,
  input: CommandScope & { request: DraftApplyAllBody; signal?: AbortSignal },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "apply_items",
    draftId: request.draftId,
    selectors: {},
    body,
  });
  const draftId = request.draftId as DraftId;
  return commandIngress(deps, input, envelope, {}, async () => {
    const active = await deps.documentSync.draftReview.items({ workId: input.workId });
    if (active.draftId !== draftId) return { refusal: goneDraft(draftId) };
    // The grants of every ref that is still addressable, listed or not (a writer may have
    // emptied one since the page rendered); one that isn't answers stale from the service.
    const resolved = await Promise.all(
      request.items.map((ref) =>
        deps.documentSync.draftReview.resolveItem({ workId: input.workId, itemKey: ref.itemKey }),
      ),
    );
    return {
      grants: await applyGrants(deps, {
        ...input,
        items: resolved.flatMap((found) => (found ? [found.item] : [])),
      }),
      effect: () =>
        deps.documentSync.draftReview.applyAll({
          workId: input.workId,
          draftId,
          items: request.items,
          userId: input.userId,
          envelope,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
    };
  });
}

/**
 * Item Discard (the whole item through the one kernel, close-only): a created, binary or
 * live-deleted item. A document deleted live authorizes through the draft (§13.3). A text edit's
 * Discard is local to the editor and never reaches the server.
 */
export async function handleDiscardWorkDraftRequest(
  deps: DraftRouteServices,
  input: CommandScope & {
    documentId: DocumentId;
    request: DraftItemDiscardBody;
  },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "discard_items",
    draftId: request.draftId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, {}, async () => {
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
 * Discard all (§12.3): the whole draft, one server command; it always closes the draft. The
 * request's draft must be the Work's active one (else `gone`).
 */
export async function handleDiscardAllWorkDraftRequest(
  deps: DraftRouteServices,
  input: CommandScope & { request: DraftDiscardAllBody },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "discard_draft",
    draftId: request.draftId,
    selectors: {},
    body,
  });
  const draftId = request.draftId as DraftId;
  return commandIngress(deps, input, envelope, {}, async () => {
    const listed = await deps.documentSync.draftReview.addressableItems({ workId: input.workId });
    if (listed.draftId !== draftId) return { refusal: goneDraft(draftId) };
    // Every addressable item, so an emptied, unlisted one still gets its grant.
    return {
      grants: await applyGrants(deps, { ...input, items: listed.items }, { live: false }),
      effect: () =>
        deps.documentSync.draftReview.discardAll({
          workId: input.workId,
          draftId,
          userId: input.userId,
          envelope,
        }),
    };
  });
}

// --- Wire --------------------------------------------------------------------------------------

export function toWireItem(
  item: DraftReviewItem,
  threadTitles: ReadonlyMap<string, string>,
): ThreadDraftListItem {
  return {
    draftId: item.draftId,
    itemKey: item.itemKey,
    documentId: item.documentId,
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
    // Throws the HTTP error of a known publication failure; the service already answered a
    // staged Apply as pending, so a value here is nothing to return.
    draftPublicationHttpAnswer(cause);
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
