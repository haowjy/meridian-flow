/**
 * Route core for authenticated draft review over a Work's branch: the list, the preview,
 * and every Apply and Discard command by `itemKey` (contract §3, §4). A command carries a
 * client `commandId`: the route looks it up before grants (so a resend after the branch
 * drained still gets its stored answer), builds the digest envelope, and maps the service's
 * outcome to HTTP. Nothing here decides an effect.
 */

import type { BranchId, DocumentCommandId, DraftOwner } from "@meridian/contracts";
import {
  type DraftOwnerKey,
  draftItemKey,
  draftOwnerFromKey,
  parseDraftItemKey,
} from "@meridian/contracts";
import {
  type ApplyClickAnswer,
  type ApplyClickResult,
  type ApplyItemsClick,
  type ApplyTextCut,
  type BranchDiscardRequest,
  type DiscardCommandResult,
  DOCUMENT_COMMAND_CONFLICT_CODE,
  DocumentCommandIdSchema,
  type DocumentCommandKind,
  type DocumentCommandLookupResponse,
  type DocumentDraftHint,
  type DocumentDraftHintsResponse,
  type DraftMetadataResponse,
  type ThreadDraftListItem,
  type ThreadDraftListResponse,
  type UnapplyClickAnswer,
  type UnapplyClickResult,
  type UndoDiscardAnswer,
  type UndoDiscardResult,
} from "@meridian/contracts/branches";
import { isProjectScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { draftRoomName, meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import { z } from "zod";
import type { CommandOutcome } from "../domains/collab/contracts.js";
import type { DiscardSelection } from "../domains/collab/domain/branch-discard.js";
import type { DraftReviewItem } from "../domains/collab/domain/branch-review-items.js";
import {
  commandDigest,
  type DocumentCommandEnvelope,
  replay,
} from "../domains/collab/domain/document-commands.js";
import type { DocumentBranchOrigin } from "../domains/collab/domain/ports/work-branch-pending-store.js";
import { reviewContextLocation } from "../domains/collab/domain/work-branch-review-service.js";
import {
  type FileAccessDenied,
  type FileGrant,
  type FileNeed,
  isFileAccessDenied,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { type BranchOwnerLifecycle, ownerKeyOfColumns } from "../shared/draft-owner.js";
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

/** A branch in the writer's project, with its owner and the owner's lifecycle as it reads now. */
export type BranchAccess = {
  branchId: BranchId;
  /** Null for a closed branch whose owner is gone. */
  owner: DraftOwner | null;
  lifecycle: BranchOwnerLifecycle;
};

async function requireProjectOwned(
  deps: Pick<BranchRouteServices, "projects">,
  input: { projectId: ProjectId; userId: UserId },
): Promise<void> {
  const project = await deps.projects.findById(input.projectId);
  if (!project || project.userId !== input.userId || project.deletedAt) {
    throw createError({ statusCode: 404, message: "Branch not found" });
  }
}

/** The branch the URL names: this writer's project, whatever its status or owner's state. */
async function requireBranchIdentity(
  deps: Pick<BranchRouteServices, "projects" | "documentSync">,
  input: { projectId: ProjectId; branchId: BranchId; userId: UserId },
): Promise<BranchAccess> {
  const access = await branchIdentityOrGone(deps, input);
  if (!access) throw createError({ statusCode: 404, message: "Branch not found" });
  return access;
}

/** `requireBranchIdentity`, or null when the branch is gone (its Work was purged). */
async function branchIdentityOrGone(
  deps: Pick<BranchRouteServices, "projects" | "documentSync">,
  input: { projectId: ProjectId; branchId: BranchId; userId: UserId },
): Promise<BranchAccess | null> {
  await requireProjectOwned(deps, input);
  const found = await deps.documentSync.draftReview.branchOwner(input.branchId);
  if (!found) return null;
  if (found.branch.projectId !== input.projectId)
    throw createError({ statusCode: 404, message: "Branch not found" });
  return { branchId: input.branchId, owner: found.owner, lifecycle: found.lifecycle };
}

/** `requireBranchIdentity`, and the owner is not deleted. */
export async function requireBranchAccess(
  deps: Pick<BranchRouteServices, "projects" | "documentSync">,
  input: { projectId: ProjectId; branchId: BranchId; userId: UserId },
): Promise<BranchAccess> {
  const access = await requireBranchIdentity(deps, input);
  if (access.lifecycle === "deleted") {
    throw createError({ statusCode: 404, message: "Branch not found" });
  }
  return access;
}

/** The owner a list names: a Work of this project that is not deleted, or a lineage of it. */
async function requireListedOwner(
  deps: Pick<BranchRouteServices, "projects" | "works">,
  input: { projectId: ProjectId; owner: string; userId: UserId },
): Promise<DraftOwner> {
  await requireProjectOwned(deps, input);
  const owner = draftOwnerFromKey(input.owner, input.projectId);
  if (!owner) throw createError({ statusCode: 400, message: "Invalid draft owner" });
  if (owner.kind === "work") {
    // A deleted Work's drafts still read until it is purged: it stays picked, with Restore.
    const work = await deps.works.findById(owner.workId);
    if (!work || work.projectId !== input.projectId) {
      throw createError({ statusCode: 404, message: "Work not found" });
    }
  }
  return owner;
}

// --- Request bodies ----------------------------------------------------------------------------

const Base = {
  branchId: z.string().uuid(),
  itemKey: z.string().max(80),
  commandId: DocumentCommandIdSchema,
};
const RangeBody = z
  .strictObject({
    from: z.number().int().nonnegative().safe(),
    to: z.number().int().nonnegative().safe(),
  })
  .refine((range) => range.to >= range.from);
const BaseViewDeltaBody = z.array(
  z.strictObject({
    base: RangeBody,
    draft: RangeBody,
    blocks: z.array(z.object({ type: z.string() }).catchall(z.unknown())),
  }),
);
const ApplyClickBody = z
  .strictObject({
    draftId: z.string().min(1).max(128).optional(),
    commandId: DocumentCommandIdSchema,
    snapshot: z.string().min(1).optional(),
    baseViewDelta: BaseViewDeltaBody,
    groupIds: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length),
    restore: z.literal(true).optional(),
    tree: z
      .strictObject({
        revision: z
          .string()
          .regex(/^[0-9a-f]{32}$/)
          .nullable(),
      })
      .optional(),
  })
  .refine((body) => Boolean(body.snapshot) === Boolean(body.draftId));
type ApplyClickRequest = z.infer<typeof ApplyClickBody>;
const UnapplyClickBody = z.strictObject({
  commandId: DocumentCommandIdSchema,
  applyCommandId: DocumentCommandIdSchema,
});
const ApplyTextBody = z.strictObject({
  draftId: z.string().min(1).max(128),
  snapshot: z.string().min(1),
  baseViewDelta: BaseViewDeltaBody,
  groupIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
});
const ApplyItemsBody = z.strictObject({
  commandId: DocumentCommandIdSchema,
  items: z
    .array(
      z
        .strictObject({
          node: z.string().uuid(),
          tree: z
            .strictObject({
              revision: z
                .string()
                .regex(/^[0-9a-f]{32}$/)
                .nullable(),
            })
            .optional(),
          text: ApplyTextBody.optional(),
        })
        .refine((item) => item.tree !== undefined || item.text !== undefined),
    )
    .min(1)
    .max(2000)
    .refine((items) => new Set(items.map((item) => item.node)).size === items.length),
  restore: z.literal(true).optional(),
});
const UndoDiscardBody = z.strictObject({
  commandId: DocumentCommandIdSchema,
  discardCommandId: DocumentCommandIdSchema,
});
const DiscardBody = z.discriminatedUnion("ends", [
  z.strictObject({ ...Base, ends: z.literal("tree") }),
  z.strictObject({
    ...Base,
    ends: z.literal("item"),
    draftSeenAt: z.iso.datetime().nullable().optional(),
  }),
]);

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw createError({ statusCode: 400, message: `Invalid ${what} request` });
  return parsed.data;
}

export const parseDraftDiscardItem = (body: unknown) => parseBody(DiscardBody, body, "Discard");

// --- Commands: envelope, lookup, outcome -------------------------------------------------------

type CommandScope = { projectId: ProjectId; branchId: BranchId; userId: UserId };

function envelopeOf(
  scope: CommandScope,
  command: {
    commandId: string;
    kind: DocumentCommandKind;
    branchId: string;
    selectors: Record<string, string | null>;
    body: unknown;
  },
): DocumentCommandEnvelope {
  return {
    commandId: command.commandId as DocumentCommandId,
    accountId: scope.userId,
    projectId: scope.projectId,
    kind: command.kind,
    digest: commandDigest({
      accountId: scope.userId,
      projectId: scope.projectId,
      branchId: scope.branchId,
      kind: command.kind,
      selectors: { branchId: command.branchId, ...command.selectors },
      body: command.body,
    }),
  };
}

export type CommandRouteResult = { httpStatus: 200; body: DiscardCommandResult };

/** Map stored Discard results and command-id conflicts to HTTP. */
function respond(outcome: CommandOutcome): CommandRouteResult {
  switch (outcome.kind) {
    case "conflict":
      return throwHttpInterrupt(
        meridianErrorFromSystem(
          DOCUMENT_COMMAND_CONFLICT_CODE,
          "That command id was used for a different command",
          false,
        ),
        409,
      );
    case "result": {
      return { httpStatus: 200, body: outcome.result };
    }
  }
}

/** The stored answer of a command id this account already used, looked up before any grant. */
async function recorded(
  deps: BranchRouteServices,
  envelope: DocumentCommandEnvelope,
): Promise<CommandRouteResult | null> {
  const stored = replay<DiscardCommandResult>(
    await deps.documentSync.draftReview.lookupCommand(envelope),
    envelope.commandId,
  );
  if (!stored) return null;
  return respond(
    stored.status === "conflict" ? { kind: "conflict" } : { kind: "result", result: stored },
  );
}

/**
 * GET /api/document-commands/:id: what a command settled as, never a guess from the list.
 * Another account's id answers `none`, revealing nothing.
 */
export async function handleDocumentCommandLookup(
  deps: Pick<BranchRouteServices, "documentSync">,
  input: { userId: UserId; commandId: string },
): Promise<DocumentCommandLookupResponse> {
  const id = DocumentCommandIdSchema.safeParse(input.commandId);
  if (!id.success) return { status: "none" };
  const found = await deps.documentSync.draftReview.lookupCommand({
    commandId: id.data as DocumentCommandId,
    accountId: input.userId,
  });
  return found.kind === "stored"
    ? { status: "stored", kind: found.commandKind, outcome: found.outcome }
    : { status: "none" };
}

// --- Grants ------------------------------------------------------------------------------------

/**
 * A pending existing document is authorized by its stable live identity when its proposed
 * branch placement cannot be resolved. Project and Work ownership are checked separately by
 * every caller; this fallback never makes a hidden creation addressable outside its branch.
 */
async function authorizeReviewItem<N extends FileNeed>(
  deps: BranchRouteServices,
  input: { owner: DraftOwner; documentId: DocumentId; userId: UserId },
  item: Pick<DraftReviewItem, "isNew">,
  need: N,
): Promise<FileGrant<N> | FileAccessDenied> {
  const draft = await deps.fileAccess.authorize(
    { accountId: input.userId },
    { kind: "draft", documentId: input.documentId, owner: input.owner },
    need,
  );
  if (!isFileAccessDenied(draft)) return draft;
  if (item.isNew) return draft;
  return deps.fileAccess.authorize(
    { accountId: input.userId },
    documentTarget(input.documentId),
    need,
  );
}

async function requireReviewItemGrant<N extends FileNeed>(
  deps: BranchRouteServices,
  input: { owner: DraftOwner; documentId: DocumentId; userId: UserId },
  item: Pick<DraftReviewItem, "isNew">,
  need: N,
): Promise<FileGrant<N>> {
  const grant = await authorizeReviewItem(deps, input, item, need);
  if (isFileAccessDenied(grant)) throw createError({ statusCode: 404, message: "Draft not found" });
  return grant;
}

/**
 * The edit grants an Apply needs (TM "Authorization", §13.3): the draft's grant on each item,
 * and the live grant on one live readers see. A document deleted live authorizes at its final
 * location's source through the draft's destination (F9). A Discard changes only the draft,
 * so it needs the draft's grants alone, at the `discard` need: a trashed chat's frozen lineage
 * refuses Apply and edits but not throwing its drafts away.
 */
async function applyGrants(
  deps: BranchRouteServices,
  input: CommandScope & { owner: DraftOwner; items: readonly DraftReviewItem[] },
  need: "edit" | "discard" = "edit",
): Promise<FileGrant<"edit" | "discard">[]> {
  const grants: FileGrant<"edit" | "discard">[] = [];
  for (const item of input.items) {
    if (item.deletedLive) {
      grants.push(await restoreGrant(deps, input, item, need));
      continue;
    }
    grants.push(
      await requireReviewItemGrant(deps, { ...input, documentId: item.documentId }, item, need),
    );
    if (need === "edit" && !item.isNew)
      grants.push(
        await requireFileGrant(
          deps.fileAccess,
          input.userId,
          documentTarget(item.documentId),
          "edit",
        ),
      );
  }
  return grants;
}

async function restoreGrant<N extends FileNeed = "edit">(
  deps: BranchRouteServices,
  input: { projectId: ProjectId; owner: DraftOwner; userId: UserId },
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
    { kind: "draft", owner: input.owner, ownerHandle: null },
    need,
  );
  if (isFileAccessDenied(grant)) throw createError({ statusCode: 404, message: "Draft not found" });
  return grant;
}

// --- Reads -------------------------------------------------------------------------------------

export async function handleOwnerDraftListRequest(
  deps: BranchRouteServices,
  input: { projectId: ProjectId; owner: string; userId: UserId },
): Promise<ThreadDraftListResponse> {
  const owner = await requireListedOwner(deps, input);
  const listed = await deps.documentSync.draftReview.listItems({ owner });
  // Readable in the branch's view, where its created documents are (file-access §6); a
  // document deleted live is no longer readable anywhere, but stays the branch's item.
  const readable = listed.branchId
    ? await deps.fileAccess.listAccess(
        { accountId: input.userId },
        listed.items.map((item) => item.documentId),
        {
          // A document the branch deletes is gone from its view; it is read where it still is.
          branchViews: new Map(
            listed.items
              .filter((item) => !item.tree?.deleted)
              .map((item) => [
                item.documentId,
                { kind: "branch" as const, branchId: listed.branchId as BranchId },
              ]),
          ),
        },
      )
    : new Map();
  // A broken proposed placement must not erase a pending fact. Existing documents retain
  // their stable live-source authority even when the branch view cannot resolve an ancestor.
  const liveReadable = await deps.fileAccess.listAccess(
    { accountId: input.userId },
    listed.items.filter((item) => !item.isNew).map((item) => item.documentId),
  );
  // The branch's owner lifecycle is the one the draft rooms and commands enforce.
  const frozen =
    listed.branchId !== null &&
    (await deps.documentSync.draftReview.branchOwner(listed.branchId))?.lifecycle === "frozen";
  return {
    items: listed.items
      .filter(
        (item) =>
          readable.has(item.documentId) || liveReadable.has(item.documentId) || item.deletedLive,
      )
      .map((item) => toWireItem(item, listed.threadTitles)),
    branchId: listed.branchId,
    folders: listed.folders,
    frozen,
  };
}

/**
 * Addressability is independent of list membership and reads only persisted metadata.
 * Disposition precedes the content grant: the active draft is what grants reading a document
 * deleted live (or a creation the manuscript never had), so once Discard retires it the grant
 * is gone too, and a device that did not discard must still learn `gone` from the Work's owner.
 */
export async function handleDraftMetadataRequest(
  deps: BranchRouteServices,
  input: CommandScope & { documentId: DocumentId; itemKey: string },
): Promise<DraftMetadataResponse> {
  const access = await requireBranchAccess(deps, input);
  if (parseDraftItemKey(input.itemKey)?.documentId !== input.documentId)
    throw createError({ statusCode: 404, message: "Draft not found" });
  const resolved = await deps.documentSync.draftReview.resolveItem({ itemKey: input.itemKey });
  if (
    !resolved ||
    resolved.documentId !== input.documentId ||
    resolved.branchId !== input.branchId ||
    !access.owner
  )
    return { status: "gone" };
  await requireReviewItemGrant(deps, { ...input, owner: access.owner }, resolved.item, "read");
  if (!resolved.draftId) return { status: "tree-only", item: toWireItem(resolved.item, new Map()) };
  return {
    status: "active",
    draftId: resolved.draftId,
    reviewRoomName: draftRoomName(resolved.draftId),
    item: toWireItem(resolved.item, new Map()),
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
    items: await Promise.all(
      branches.map(async (branch) => ({
        branchId: branch.branchId,
        itemKey: draftItemKey(branch.branchId, input.documentId),
        label: branch.originLabel,
        owner: ownerKeyOfColumns({
          workId: branch.originWorkId,
          rootThreadId: branch.originRootThreadId,
        }) as DraftOwnerKey,
        tree: await pendingTreeChange(deps, branch, input.documentId),
      })),
    ),
  };
}

/** What the branch's row does to the document's placement, for the draft notice on live. */
async function pendingTreeChange(
  deps: BranchRouteServices,
  branch: DocumentBranchOrigin,
  documentId: DocumentId,
): Promise<DocumentDraftHint["tree"]> {
  const resolved = await deps.documentSync.draftReview.resolveItemInBranch({
    branchId: branch.branchId,
    documentId,
  });
  const tree = resolved?.item.tree ?? null;
  if (tree?.deleted) return { deleted: true };
  const movedTo = tree?.movedFrom ? reviewContextLocation(resolved?.item.path ?? null) : null;
  return movedTo ? { movedTo } : null;
}

// --- Commands ----------------------------------------------------------------------------------

/** Resolves a command's item for a URL document, or null when it is not that document's item. */
async function commandItem(
  deps: BranchRouteServices,
  input: { documentId: DocumentId; request: { branchId: string; itemKey: string } },
): Promise<DraftReviewItem | null> {
  const resolved = await deps.documentSync.draftReview.resolveItem({
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
  | { grants: FileGrant<"edit" | "discard">[]; effect: () => Promise<CommandOutcome> };

/**
 * The one ingress every branch command goes through. After authenticated project and branch
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
  envelope: DocumentCommandEnvelope,
  prepare: (access: BranchAccess) => Promise<PreparedCommand>,
): Promise<CommandRouteResult> {
  const access = await requireBranchAccess(deps, input);
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
    prepared = await prepare(access);
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
  return respond(outcome);
}

/** Why a grant was refused, as the reason an Apply or an Undo of a Discard answers. */
function denialReason(grant: FileAccessDenied) {
  return grant.facts?.branchOwner?.deleted || grant.facts?.ownerWork?.deleted
    ? ("work_deleted" as const)
    : grant.reason === "work_archived" || grant.reason === "chat_frozen"
      ? grant.reason
      : ("not_found" as const);
}

/**
 * The per-document click as the one-item Apply it is; null when its cuts are malformed: a text
 * cut needs its room (`draftId`, `snapshot`) and a click needs a text cut or a tree cut.
 */
function itemsOfClick(documentId: DocumentId, click: ApplyClickRequest): ApplyItemsClick | null {
  const textCut =
    click.snapshot !== undefined || click.groupIds.length > 0 || click.baseViewDelta.length > 0;
  if (!textCut && !click.tree) return null;
  if (textCut && (!click.draftId || !click.snapshot || click.groupIds.length === 0)) return null;
  return {
    commandId: click.commandId as DocumentCommandId,
    items: [
      {
        node: documentId,
        ...(click.tree ? { tree: click.tree } : {}),
        ...(textCut
          ? {
              text: {
                draftId: click.draftId as string,
                snapshot: click.snapshot as string,
                baseViewDelta: click.baseViewDelta as ApplyTextCut["baseViewDelta"],
                groupIds: click.groupIds,
              },
            }
          : {}),
      },
    ],
    ...(click.restore ? { restore: true as const } : {}),
  };
}

/**
 * The one Apply: any selection of nodes, a per-document click being the one-item case. It
 * takes the grants every item needs, whatever the route it came by: the draft's grant and the
 * live grant on each document, and a restore grant on one live has deleted (it authorizes at
 * its source through the draft's destination, F9). A folder has no file of its own: the writer
 * owns the project, which the branch's identity proved. `request` null is a malformed click.
 */
async function applyItems(
  deps: BranchRouteServices,
  input: CommandScope,
  request: ApplyItemsClick | null,
  envelope: DocumentCommandEnvelope,
  /** Set on the one re-run after a live delete overtook this click's admission. */
  overtaken = false,
): Promise<ApplyClickAnswer> {
  const access = await requireBranchIdentity(deps, input);
  const { commandId } = envelope;
  const lookup = async (): Promise<ApplyClickAnswer | null> =>
    replay<ApplyClickResult>(
      await deps.documentSync.draftReview.lookupCommand(envelope),
      commandId,
    );
  const recorded = await lookup();
  if (recorded) return recorded;
  const refuse = async (
    reason: import("@meridian/contracts/branches").ApplyClickRefusalReason,
  ): Promise<ApplyClickAnswer> => (await lookup()) ?? { status: "refused", commandId, reason };
  const { owner } = access;
  if (!request) return refuse("malformed");
  if (!owner) return refuse("not_found");
  if (access.lifecycle === "deleted") return refuse("work_deleted");
  if (access.lifecycle === "frozen") return refuse("chat_frozen");
  if (access.lifecycle === "archived") return refuse("work_archived");
  const resolved = await Promise.all(
    request.items.map(async (entry) => ({
      node: entry.node as DocumentId,
      found: await deps.documentSync.draftReview.resolveItemInBranch({
        branchId: input.branchId,
        documentId: entry.node as DocumentId,
      }),
    })),
  );
  const deletedLive = resolved.some(({ found }) => found?.item.deletedLive);
  async function deniedAnswer(
    grant: FileAccessDenied,
    node: DocumentId,
  ): Promise<ApplyClickAnswer> {
    // A known removed identity is a terminal room outcome, not an edit denial.
    // Never expose its record to a different owner or project.
    if (
      grant.facts?.deleted &&
      grant.facts.ownerAccountId === input.userId &&
      grant.facts.projectId === input.projectId
    ) {
      const removed = await deps.documentSync.roomRemoval({ documentId: node });
      if (removed) return (await lookup()) ?? { status: "closed", commandId };
    }
    return refuse(denialReason(grant));
  }
  // A live delete that committed after the items resolved, at authorization or at the grants'
  // confirmation: nothing was claimed, so the click runs once more, resolves the item as
  // deleted and authorizes its restore. Every other denial is final.
  const denied = (denial: FileAccessDenied | undefined, node: DocumentId) =>
    denial?.facts?.deleted && !deletedLive && !overtaken
      ? applyItems(deps, input, request, envelope, true)
      : denial
        ? deniedAnswer(denial, node)
        : refuse("not_found");
  const grants: FileGrant<"edit">[] = [];
  for (const { node, found } of resolved) {
    if (!found) continue;
    const { item } = found;
    // A drafted delete of a document live deleted too has no draft to read: the click only
    // settles the branch's row, authorized like a restore through the draft's destination.
    if (!(item.deletedLive && item.tree?.deleted === true)) {
      const grant = await authorizeReviewItem(
        deps,
        { ...input, owner, documentId: node },
        item,
        "edit",
      );
      if (isFileAccessDenied(grant)) return denied(grant, node);
      grants.push(grant);
    }
    if (!item.isNew && !item.deletedLive) {
      const live = await deps.fileAccess.authorize(
        { accountId: input.userId },
        documentTarget(node),
        "edit",
      );
      if (isFileAccessDenied(live)) return denied(live, node);
      grants.push(live);
    }
    if (item.deletedLive) grants.push(await restoreGrant(deps, { ...input, owner }, item));
  }
  const result = await runWithEditGrants(deps.fileAccess, grants, () =>
    deps.documentSync.draftReview.apply({ branchId: input.branchId, request, envelope }),
  );
  return result.ok
    ? result.value
    : denied(result.refusal.refused[0], (resolved[0]?.node ?? input.branchId) as DocumentId);
}

/** One document's click: the one-item Apply, in the shape the document's review room sends. */
export async function handleApplyClickRequest(
  deps: BranchRouteServices,
  input: CommandScope & { documentId: DocumentId; request: unknown },
): Promise<ApplyClickAnswer> {
  const parsedId = DocumentCommandIdSchema.safeParse(
    input.request && typeof input.request === "object" && "commandId" in input.request
      ? input.request.commandId
      : undefined,
  );
  if (!parsedId.success) throw createError({ statusCode: 400, message: "Invalid Apply request" });
  const parsed = ApplyClickBody.safeParse(input.request);
  return applyItems(
    deps,
    input,
    parsed.success ? itemsOfClick(input.documentId, parsed.data) : null,
    envelopeOf(input, {
      commandId: parsedId.data,
      kind: "apply",
      branchId: input.branchId,
      selectors: { documentId: input.documentId },
      body: input.request,
    }),
  );
}

/** A branch-level command: the project's branch, the parsed body and the command's envelope. */
async function branchCommand<Request extends { commandId: string }, Answer, Access = BranchAccess>(
  deps: BranchRouteServices,
  input: CommandScope & { request: unknown },
  command: {
    kind: DocumentCommandKind;
    what: string;
    schema: z.ZodType<Request>;
    /** Resolves the branch; the default answers a missing one with 404. */
    identity?: (deps: BranchRouteServices, input: CommandScope) => Promise<Access>;
    run(call: {
      request: Request;
      envelope: DocumentCommandEnvelope;
      access: Access;
    }): Promise<Answer>;
  },
): Promise<Answer> {
  const access = await (command.identity ?? (requireBranchIdentity as never))(deps, input);
  const request = parseBody(command.schema, input.request, command.what);
  return command.run({
    request,
    access,
    envelope: envelopeOf(input, {
      commandId: request.commandId,
      kind: command.kind,
      branchId: input.branchId,
      selectors: {},
      body: request,
    }),
  });
}

/** Apply any selection of nodes, a folder and what is under it, as one command. */
export function handleApplyItemsRequest(
  deps: BranchRouteServices,
  input: CommandScope & { request: unknown },
): Promise<ApplyClickAnswer> {
  const request = parseBody(ApplyItemsBody, input.request, "Apply") as ApplyItemsClick;
  return applyItems(
    deps,
    input,
    request,
    envelopeOf(input, {
      commandId: request.commandId,
      kind: "apply",
      branchId: input.branchId,
      selectors: {},
      body: request,
    }),
  );
}

/**
 * The edit grant on a document a command writes back: Un-Apply and Undo of a Discard take it on
 * every document the command's own record names (`commandDocuments`). With a draft `owner` (Undo
 * of a Discard), the document is written in that owner's draft: through the draft itself, else
 * through the restore seam at the draft's destination, where a creation only the Work shows has
 * its identity once its draft closed. Else, and as the last resort, its live grant, or the
 * restore grant when live has deleted it.
 */
async function documentGrant(
  deps: BranchRouteServices,
  input: CommandScope,
  documentId: DocumentId,
  owner: DraftOwner | null,
): Promise<FileGrant<"edit"> | FileAccessDenied> {
  const principal = { accountId: input.userId };
  if (owner) {
    const draft = await deps.fileAccess.authorize(
      principal,
      { kind: "draft", documentId, owner },
      "edit",
    );
    if (!isFileAccessDenied(draft)) return draft;
    const restored = await deps.fileAccess.authorizeAt(
      principal,
      { kind: "restore", documentId },
      { kind: "draft", owner, ownerHandle: null },
      "edit",
    );
    if (!isFileAccessDenied(restored)) return restored;
  }
  const live = await deps.fileAccess.authorize(principal, documentTarget(documentId), "edit");
  if (!isFileAccessDenied(live) || !live.facts?.deleted) return live;
  return deps.fileAccess.authorize(principal, { kind: "restore", documentId }, "edit");
}

/**
 * Undo of a Discard names a creation only the Work showed: no tree row exists for it until the
 * command's own copy brings it back, so no target resolves it. The Work's lifecycle, which the
 * command's Work lock checks, is the only authority over it.
 */
const unseen = (grant: FileGrant<"edit"> | FileAccessDenied) =>
  isFileAccessDenied(grant) && grant.reason === "not_found" && grant.facts === null;

/** Take back one Apply command: its text groups and everything it settled in the tree. */
export function handleUnapplyClickRequest(
  deps: BranchRouteServices,
  input: CommandScope & { request: unknown },
): Promise<UnapplyClickAnswer> {
  return branchCommand(deps, input, {
    kind: "unapply",
    what: "Un-Apply",
    schema: UnapplyClickBody,
    run: async ({ request, envelope }) => {
      const lookup = async () =>
        replay<UnapplyClickResult>(
          await deps.documentSync.draftReview.lookupCommand(envelope),
          request.commandId,
        );
      const recorded = await lookup();
      if (recorded) return recorded;
      const refused = async (): Promise<UnapplyClickAnswer> =>
        (await lookup()) ?? {
          status: "refused",
          commandId: request.commandId as DocumentCommandId,
        };
      const grants: FileGrant<"edit">[] = [];
      for (const documentId of await deps.documentSync.draftReview.commandDocuments.ofApply({
        applyCommandId: request.applyCommandId as DocumentCommandId,
        accountId: input.userId,
        branchId: input.branchId,
      })) {
        const grant = await documentGrant(deps, input, documentId, null);
        if (isFileAccessDenied(grant)) return refused();
        grants.push(grant);
      }
      const result = await runWithEditGrants(deps.fileAccess, grants, () =>
        deps.documentSync.draftReview.unapplyClick({ branchId: input.branchId, request, envelope }),
      );
      return result.ok ? result.value : refused();
    },
  });
}

/** Take back a Discard: the Work gets fresh pending copies of what it settled and closed. */
export function handleUndoDiscardRequest(
  deps: BranchRouteServices,
  input: CommandScope & { request: unknown },
): Promise<UndoDiscardAnswer> {
  return branchCommand(deps, input, {
    kind: "undo_discard",
    what: "Undo of a Discard",
    schema: UndoDiscardBody,
    // A stale Trash screen may name a purged Work's branch: the command stores `work_purged`.
    identity: branchIdentityOrGone,
    run: async ({ request, envelope, access }) => {
      const commandId = request.commandId as DocumentCommandId;
      const lookup = async () =>
        replay<UndoDiscardResult>(
          await deps.documentSync.draftReview.lookupCommand(envelope),
          commandId,
        );
      const recorded = await lookup();
      if (recorded) return recorded;
      const grants: FileGrant<"edit">[] = [];
      for (const documentId of access
        ? await deps.documentSync.draftReview.commandDocuments.ofDiscard({
            discardCommandId: request.discardCommandId as DocumentCommandId,
            accountId: input.userId,
            branchId: input.branchId,
          })
        : []) {
        const grant = await documentGrant(deps, input, documentId, access?.owner ?? null);
        if (unseen(grant)) continue;
        if (isFileAccessDenied(grant))
          return (await lookup()) ?? { status: "refused", commandId, reason: denialReason(grant) };
        grants.push(grant);
      }
      const result = await runWithEditGrants(deps.fileAccess, grants, () =>
        deps.documentSync.draftReview.undoDiscard({
          branchId: input.branchId,
          userId: input.userId,
          request,
          envelope,
        }),
      );
      return result.ok
        ? result.value
        : ((await lookup()) ?? {
            status: "refused",
            commandId,
            reason: denialReason(result.refusal.refused[0] as FileAccessDenied),
          });
    },
  });
}

/** An item the branch no longer holds, as a 200 body status. */
const goneItem = (request: { branchId: string; itemKey: string }) => (): CommandRouteResult => ({
  httpStatus: 200,
  body: { status: "gone", branchId: request.branchId as BranchId, itemKey: request.itemKey },
});

/** A branch that is not active any more, as a 200 body status. */
const goneBranch = (branchId: BranchId) => (): CommandRouteResult => ({
  httpStatus: 200,
  body: { status: "gone", branchId },
});

/**
 * Item Discard through the one kernel (§12.3): the move or delete only, or the whole item, as
 * the request says. A document deleted live authorizes through the draft (§13.3).
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
    kind: "discard",
    branchId: request.branchId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, async ({ owner }) => {
    const item = request.branchId === input.branchId ? await commandItem(deps, input) : null;
    if (!item || !owner) return { refusal: goneItem(request) };
    return {
      grants: await applyGrants(deps, { ...input, owner, items: [item] }, "discard"),
      effect: () =>
        deps.documentSync.draftReview.discardItem({
          item,
          ends: request.ends,
          ...(request.ends === "item" && request.draftSeenAt !== undefined
            ? { draftSeenAt: request.draftSeenAt }
            : {}),
          userId: input.userId,
          envelope,
        }),
    };
  });
}

/**
 * The branch's Discard (§12.3), one server command: Discard all, which always closes the branch,
 * or a selection of nodes. A selected document needs the draft's grant, as an item Discard does;
 * a folder has no file of its own, and the branch's identity proved the writer owns the project.
 * A node the branch holds no change on refuses the whole selection as `stale`.
 */
export async function handleDiscardBranchRequest(
  deps: BranchRouteServices,
  input: CommandScope & { request: BranchDiscardRequest },
): Promise<CommandRouteResult> {
  const { request } = input;
  const { commandId: _, ...body } = request;
  const envelope = envelopeOf(input, {
    commandId: request.commandId,
    kind: "discard",
    branchId: input.branchId,
    selectors: {},
    body,
  });
  const { branchId } = input;
  return commandIngress(deps, input, envelope, async ({ owner }) => {
    if (!owner) return { refusal: goneBranch(branchId) };
    const listed = await deps.documentSync.draftReview.listItems({ owner });
    if (listed.branchId !== branchId) return { refusal: goneBranch(branchId) };
    const discard = (selection: DiscardSelection) => () =>
      deps.documentSync.draftReview.discardBranch({
        branchId,
        selection,
        userId: input.userId,
        envelope,
      });
    if ("all" in request)
      return {
        grants: await applyGrants(deps, { ...input, owner, items: listed.items }, "discard"),
        effect: discard({ kind: "whole" }),
      };
    const byNode = new Map(listed.items.map((item) => [item.documentId as string, item]));
    const folders = new Set(listed.folders.map((folder) => folder.id));
    const items = request.items.flatMap((entry) => {
      const item = byNode.get(entry.node);
      return item ? [item] : [];
    });
    if (request.items.some((entry) => !byNode.has(entry.node) && !folders.has(entry.node)))
      return {
        refusal: () => ({ httpStatus: 200, body: { status: "stale", branchId } }),
      };
    return {
      grants: await applyGrants(deps, { ...input, owner, items }, "discard"),
      effect: discard({
        kind: "items",
        items: request.items.map((entry) => ({
          documentId: entry.node as DocumentId,
          origin: byNode.get(entry.node)?.origin ?? "edited",
          ends: entry.ends,
          ...(entry.draftSeenAt !== undefined ? { draftSeenAt: entry.draftSeenAt } : {}),
        })),
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
    tree: item.tree
      ? {
          revision: item.tree.revision,
          ...(item.tree.movedFrom
            ? { movedFrom: reviewContextLocation(item.tree.movedFrom) ?? undefined }
            : {}),
          ...(item.tree.deleted ? { deleted: true as const } : {}),
        }
      : null,
    documentName: item.documentName,
    contextLocation: reviewContextLocation(item.path),
    deletedLive: item.deletedLive,
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
