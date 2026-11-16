/**
 * Route core for authenticated draft review over a Work's branch: the list, the preview,
 * and every Apply and Discard command by `itemKey` (contract §3, §4). A command carries a
 * client `commandId`: the route looks it up before grants (so a resend after the branch
 * drained still gets its stored answer), builds the digest envelope, and maps the service's
 * outcome to HTTP. Nothing here decides an effect.
 */

import type { BranchId, CommandId, DraftOwner } from "@meridian/contracts";
import {
  type DraftItemKey,
  type DraftOwnerKey,
  draftItemKey,
  draftOwnerFromKey,
  parseDraftItemKey,
} from "@meridian/contracts";
import type {
  ApplyClickAnswer,
  ApplyClickResult,
  ApplyItemsClick,
  ApplySpanPatch,
  ApplyTextCut,
  BranchDiscardRequest,
  DiscardCommandResult,
  DocumentDraftHint,
  DocumentDraftHintsResponse,
  DraftMetadataResponse,
  ThreadDraftListItem,
  ThreadDraftListResponse,
  UnapplyClickAnswer,
  UnapplyClickResult,
  UndoDiscardAnswer,
  UndoDiscardResult,
} from "@meridian/contracts/branches";
import {
  COMMAND_CONFLICT_CODE,
  CommandIdSchema,
  type CommandKind,
  type CommandRunning,
} from "@meridian/contracts/commands";
import { isProjectScopedScheme, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { draftRoomName, meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import * as Y from "yjs";
import { z } from "zod";
import type { CommandOutcome } from "../domains/collab/contracts.js";
import {
  ApplyClickMalformed,
  ApplyClickUnsynced,
  type TreeCut,
} from "../domains/collab/domain/apply-click.js";
import type { DiscardSelection } from "../domains/collab/domain/branch-discard.js";
import type { DraftReviewItem } from "../domains/collab/domain/branch-review-items.js";
import type { DocumentBranchOrigin } from "../domains/collab/domain/ports/work-branch-pending-store.js";
import { reviewContextLocation } from "../domains/collab/domain/work-branch-review-service.js";
import { ownedByRequest } from "../domains/context/index.js";
import {
  type FileAccessDenied,
  type FileGrant,
  type FileNeed,
  isFileAccessDenied,
  runWithEditGrants,
} from "../domains/file-policy/index.js";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { type CommandEnvelope, commandDigest, replay } from "../shared/commands/command-record.js";
import { type BranchOwnerLifecycle, ownerKeyOfColumns } from "../shared/draft-owner.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import type { AppServices } from "./app.js";
import { documentTarget, isFileAccessRefusal, withEditGrants } from "./file-access-http.js";
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
export async function requireListedOwner(
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
  commandId: CommandIdSchema,
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
/** A state vector, decoded here once: one that isn't is a 400, and nothing downstream decodes. */
const VectorBody = z.base64().transform((value, context) => {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  try {
    Y.decodeStateVector(bytes);
    return bytes;
  } catch {
    context.addIssue({ code: "custom", message: "Invalid state vector" });
    return z.NEVER;
  }
});
const ScopeCutBody = z.strictObject({ list: z.string().min(1).max(128), vector: VectorBody });
const SawBody = z.strictObject({
  project: ScopeCutBody.optional(),
  account: ScopeCutBody.optional(),
});
/**
 * `tree: true`, or a tab opened before B3: `tree: { revision }`, read as `true`. With `restore`
 * (ignored), accepted for one release after B3 deploys; remove both then.
 */
const TreeBody = z
  .union([
    z.literal(true),
    z.strictObject({
      revision: z
        .string()
        .regex(/^[0-9a-f]{32}$/)
        .nullable(),
    }),
  ])
  .transform(() => true as const);
const OldRestoreBody = z.literal(true).optional();
const ApplyClickBody = z
  .strictObject({
    draftId: z.string().min(1).max(128).optional(),
    commandId: CommandIdSchema,
    snapshot: z.string().min(1).optional(),
    whole: z.literal(true).optional(),
    baseViewDelta: BaseViewDeltaBody,
    groupIds: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length),
    tree: TreeBody.optional(),
    restore: OldRestoreBody,
    saw: SawBody.optional(),
  })
  .refine((body) =>
    body.whole
      ? Boolean(body.draftId) &&
        !body.snapshot &&
        body.groupIds.length === 0 &&
        body.baseViewDelta.length === 0
      : Boolean(body.snapshot) === Boolean(body.draftId),
  );
type ApplyClickRequest = z.infer<typeof ApplyClickBody>;
const UnapplyClickBody = z.strictObject({
  commandId: CommandIdSchema,
  applyCommandId: CommandIdSchema,
});
const ApplyTextBody = z.union([
  z.strictObject({
    draftId: z.string().min(1).max(128),
    snapshot: z.string().min(1),
    baseViewDelta: BaseViewDeltaBody,
    groupIds: z
      .array(z.string().min(1))
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
  z.strictObject({ draftId: z.string().min(1).max(128), whole: z.literal(true) }),
]);
const ApplyItemsBody = z.strictObject({
  commandId: CommandIdSchema,
  items: z
    .array(
      z
        .strictObject({
          node: z.string().uuid(),
          tree: TreeBody.optional(),
          text: ApplyTextBody.optional(),
        })
        .refine((item) => item.tree !== undefined || item.text !== undefined),
    )
    .min(1)
    .max(2000)
    .refine((items) => new Set(items.map((item) => item.node)).size === items.length),
  restore: OldRestoreBody,
  saw: SawBody.optional(),
});
/** An Apply as the route parsed it: the items, and the press's cut decoded. */
type ParsedApply = Omit<ApplyItemsClick, "saw"> & { saw?: TreeCut };
const UndoDiscardBody = z.strictObject({
  commandId: CommandIdSchema,
  discardCommandId: CommandIdSchema,
});
// Not strict: a tab still on the old code sends `branchId` and `draftSeenAt` too, and they are dropped.
const DiscardBody = z.object({
  itemKey: Base.itemKey,
  commandId: Base.commandId,
  ends: z.enum(["tree", "item"]),
});

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
    kind: CommandKind;
    branchId: string;
    selectors: Record<string, string | null>;
    body: unknown;
  },
): CommandEnvelope {
  return {
    commandId: command.commandId as CommandId,
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
          COMMAND_CONFLICT_CODE,
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
  envelope: CommandEnvelope,
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
 * The grants a Discard needs: the `command` grant on the draft of each item, which a closed
 * owner (an archived or deleted Work, a chat in Trash) does not withhold: the Work lock answers
 * such a Discard with a stored `returned`. A document deleted live authorizes at its final
 * location's source through the draft's destination (F9).
 */
async function discardGrants(
  deps: BranchRouteServices,
  input: CommandScope & { owner: DraftOwner; items: readonly DraftReviewItem[] },
): Promise<FileGrant<"command">[]> {
  const grants: FileGrant<"command">[] = [];
  for (const item of input.items) {
    grants.push(
      item.deletedLive
        ? await restoreGrant(deps, input, item, "command")
        : await requireReviewItemGrant(
            deps,
            { ...input, documentId: item.documentId },
            item,
            "command",
          ),
    );
  }
  return grants;
}

async function restoreGrant<N extends FileNeed>(
  deps: BranchRouteServices,
  input: { projectId: ProjectId; owner: DraftOwner; userId: UserId },
  item: DraftReviewItem,
  need: N,
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
  const visible = listed.items.filter(
    (item) =>
      readable.has(item.documentId) || liveReadable.has(item.documentId) || item.deletedLive,
  );
  return {
    items: visible.map((item) => toWireItem(item, listed.threadTitles)),
    branchId: listed.branchId,
    folders: listed.folders,
    frozen,
    saw: listed.saw,
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
  input: { branchId: BranchId; documentId: DocumentId; request: { itemKey: string } },
): Promise<DraftReviewItem | null> {
  const resolved = await deps.documentSync.draftReview.resolveItem({
    itemKey: input.request.itemKey,
  });
  return resolved &&
    resolved.documentId === input.documentId &&
    resolved.branchId === input.branchId
    ? resolved.item
    : null;
}

/** What a command's pre-effect phase decided: its effect, and the grants it runs under. */
type PreparedCommand = {
  grants: FileGrant<"edit" | "command">[];
  effect: () => Promise<CommandOutcome>;
};

/**
 * The one ingress every branch command goes through. After authenticated project and branch
 * access the id is looked up (a resend answers its stored outcome, §4.6); `prepare` then
 * resolves the item and acquires grants, and the grants are confirmed again before the
 * effect. A grant that has become unavailable looks the id up once more before it answers
 * (LA-1): a request that lost a race to its own twin gets the winner's outcome. Nothing here skips
 * authorization; the grants still gate every effect.
 */
async function commandIngress(
  deps: BranchRouteServices,
  input: CommandScope,
  envelope: CommandEnvelope,
  prepare: (access: BranchAccess) => Promise<PreparedCommand>,
): Promise<CommandRouteResult> {
  const access = await requireBranchIdentity(deps, input);
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

/**
 * The per-document click as the one-item Apply it is. A click that is not one a client builds is
 * a 400: a frozen text cut needs its room (`draftId`, `snapshot`), a whole cut its `draftId` (the
 * body schema holds it), and a click needs a text cut or a tree cut.
 */
function itemsOfClick(documentId: DocumentId, click: ApplyClickRequest): ParsedApply {
  const frozen =
    click.snapshot !== undefined || click.groupIds.length > 0 || click.baseViewDelta.length > 0;
  if (
    (!frozen && !click.whole && !click.tree) ||
    (frozen && (!click.draftId || !click.snapshot || click.groupIds.length === 0))
  )
    throw createError({ statusCode: 400, message: "Invalid Apply request" });
  const text: ApplyTextCut | null = click.whole
    ? { draftId: click.draftId as string, whole: true }
    : frozen
      ? {
          draftId: click.draftId as string,
          snapshot: click.snapshot as string,
          baseViewDelta: click.baseViewDelta as ApplySpanPatch[],
          groupIds: click.groupIds,
        }
      : null;
  return {
    commandId: click.commandId as CommandId,
    items: [
      {
        node: documentId,
        ...(click.tree ? { tree: true as const } : {}),
        ...(text ? { text } : {}),
      },
    ],
    ...(click.saw ? { saw: click.saw } : {}),
  };
}

/**
 * The one Apply: any selection of nodes, a per-document click being the one-item case. It
 * takes the grants every item needs, whatever the route it came by: the draft's grant and the
 * `command` grant on each live document (a closed owner's file passes: the core bounces it),
 * and a restore grant on one live has deleted (it authorizes at its source through the draft's
 * destination, F9). A folder has no file of its own: the writer
 * owns the project, which the branch's identity proved.
 */
async function applyItems(
  deps: BranchRouteServices,
  input: CommandScope,
  request: ParsedApply,
  envelope: CommandEnvelope,
): Promise<ApplyClickAnswer | CommandRunning> {
  const access = await requireBranchIdentity(deps, input);
  const { commandId } = envelope;
  const lookup = async (): Promise<ApplyClickAnswer | null> =>
    replay<ApplyClickResult>(
      await deps.documentSync.draftReview.lookupCommand(envelope),
      commandId,
    );
  // A resend of a large Apply still committing waits on it here, before anything is compiled.
  const first = await deps.documentSync.draftReview.awaitCommand(envelope);
  if (first.kind === "running") return { status: "running", commandId };
  const recorded = replay<ApplyClickResult>(first, commandId);
  if (recorded) return recorded;
  const { owner } = access;
  if (!owner) throw createError({ statusCode: 404, message: "Branch not found" });
  const resolved = await Promise.all(
    request.items.map(async (entry) => ({
      node: entry.node as DocumentId,
      found: await deps.documentSync.draftReview.resolveItemInBranch({
        branchId: input.branchId,
        documentId: entry.node as DocumentId,
      }),
    })),
  );
  // The `command` grant ignores lifecycle, a live delete included. A document whose room was
  // removed gets no grant and the command settles it (`left_out purged`). Every other denial is
  // about who is acting: a 404.
  const denied = async (denial: FileAccessDenied | undefined, node: DocumentId): Promise<void> => {
    if (
      denial?.facts?.deleted &&
      denial.facts.ownerAccountId === input.userId &&
      ownedByRequest(denial.facts.owner, { projectId: input.projectId, accountId: input.userId }) &&
      (await deps.documentSync.roomRemoval({ documentId: node }))
    )
      return;
    throw createError({ statusCode: 404, message: "Not found" });
  };
  const grants: FileGrant<"edit" | "command">[] = [];
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
        "command",
      );
      if (isFileAccessDenied(grant)) {
        await denied(grant, node);
        continue;
      }
      grants.push(grant);
    }
    if (!item.isNew && !item.deletedLive) {
      const live = await deps.fileAccess.authorize(
        { accountId: input.userId },
        documentTarget(node),
        "command",
      );
      if (isFileAccessDenied(live)) {
        await denied(live, node);
        continue;
      }
      grants.push(live);
    }
    if (item.deletedLive)
      grants.push(await restoreGrant(deps, { ...input, owner }, item, "command"));
  }
  const result = await runWithEditGrants(deps.fileAccess, grants, () =>
    callDraftReview(
      deps.documentSync.draftReview.apply({
        branchId: input.branchId,
        request: { commandId: request.commandId, items: request.items },
        ...(request.saw ? { saw: request.saw } : {}),
        envelope,
      }),
    ),
  );
  if (result.ok) return result.value;
  // The grants were refused at the seam: a document moved to another Work after they were minted.
  // The command settled nothing, so a removed room has nothing to settle here either.
  throw createError({ statusCode: 404, message: "Not found" });
}

/** One document's click: the one-item Apply, in the shape the document's review room sends. */
export async function handleApplyClickRequest(
  deps: BranchRouteServices,
  input: CommandScope & { documentId: DocumentId; request: unknown },
): Promise<ApplyClickAnswer | CommandRunning> {
  const parsedId = CommandIdSchema.safeParse(
    input.request && typeof input.request === "object" && "commandId" in input.request
      ? input.request.commandId
      : undefined,
  );
  if (!parsedId.success) throw createError({ statusCode: 400, message: "Invalid Apply request" });
  const parsed = ApplyClickBody.safeParse(input.request);
  if (!parsed.success) throw createError({ statusCode: 400, message: "Invalid Apply request" });
  return applyItems(
    deps,
    input,
    itemsOfClick(input.documentId, parsed.data),
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
    kind: CommandKind;
    what: string;
    schema: z.ZodType<Request>;
    /** Resolves the branch; the default answers a missing one with 404. */
    identity?: (deps: BranchRouteServices, input: CommandScope) => Promise<Access>;
    run(call: { request: Request; envelope: CommandEnvelope; access: Access }): Promise<Answer>;
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
): Promise<ApplyClickAnswer | CommandRunning> {
  const { restore: _ignored, ...request } = parseBody(ApplyItemsBody, input.request, "Apply");
  return applyItems(
    deps,
    input,
    request as ParsedApply,
    envelopeOf(input, {
      commandId: request.commandId,
      kind: "apply",
      branchId: input.branchId,
      selectors: {},
      // As sent: the decoded cut is not what the digest of a resend reads.
      body: input.request,
    }),
  );
}

/**
 * The edit grant on a document a command writes back: Un-Apply and Undo of a Discard take it on
 * every document the command's own record names (`commandDocuments`). With a draft `owner` (Undo
 * of a Discard), the document is written in that owner's draft: through the draft itself, else
 * through the restore seam at the draft's destination, where a creation only the Work shows has
 * its identity once its draft closed. Else its live grant: `command` passes a document live has
 * deleted.
 */
async function documentGrant(
  deps: BranchRouteServices,
  input: CommandScope,
  documentId: DocumentId,
  owner: DraftOwner | null,
): Promise<FileGrant<"edit" | "command"> | FileAccessDenied> {
  const principal = { accountId: input.userId };
  if (owner) {
    const draft = await deps.fileAccess.authorize(
      principal,
      { kind: "draft", documentId, owner },
      "command",
    );
    if (!isFileAccessDenied(draft)) return draft;
    const restored = await deps.fileAccess.authorizeAt(
      principal,
      { kind: "restore", documentId },
      { kind: "draft", owner, ownerHandle: null },
      "command",
    );
    if (!isFileAccessDenied(restored)) return restored;
  }
  return deps.fileAccess.authorize(principal, documentTarget(documentId), "command");
}

/**
 * Undo of a Discard names a creation only the Work showed: no tree row exists for it until the
 * command's own copy brings it back, so no target resolves it. The Work's lifecycle, which the
 * command's Work lock checks, is the only authority over it.
 */
const unseen = (grant: FileGrant<"edit" | "command"> | FileAccessDenied) =>
  isFileAccessDenied(grant) && grant.reason === "not_found" && grant.facts === null;

/** Take back one Apply command: its text groups and everything it settled in the tree. */
export function handleUnapplyClickRequest(
  deps: BranchRouteServices,
  input: CommandScope & { request: unknown },
): Promise<UnapplyClickAnswer | CommandRunning> {
  return branchCommand<z.infer<typeof UnapplyClickBody>, UnapplyClickAnswer | CommandRunning>(
    deps,
    input,
    {
      kind: "unapply",
      what: "Un-Apply",
      schema: UnapplyClickBody,
      run: async ({ request, envelope }) => {
        const lookup = async () =>
          replay<UnapplyClickResult>(
            await deps.documentSync.draftReview.lookupCommand(envelope),
            request.commandId,
          );
        const first = await deps.documentSync.draftReview.awaitCommand(envelope);
        if (first.kind === "running") return { status: "running", commandId: request.commandId };
        const recorded = replay<UnapplyClickResult>(first, request.commandId as CommandId);
        if (recorded) return recorded;
        // A grant denied here is about who is acting (a purged document has no applied text left
        // to write back): a 404.
        const refused = async (): Promise<UnapplyClickAnswer> =>
          (await lookup()) ??
          Promise.reject(createError({ statusCode: 404, message: "Not found" }));
        const grants: FileGrant<"edit" | "command">[] = [];
        for (const documentId of await deps.documentSync.draftReview.commandDocuments.ofApply({
          applyCommandId: request.applyCommandId as CommandId,
          accountId: input.userId,
        })) {
          const grant = await documentGrant(deps, input, documentId, null);
          if (isFileAccessDenied(grant)) return refused();
          grants.push(grant);
        }
        const result = await runWithEditGrants(deps.fileAccess, grants, () =>
          deps.documentSync.draftReview.unapplyClick({
            branchId: input.branchId,
            request,
            envelope,
          }),
        );
        return result.ok ? result.value : refused();
      },
    },
  );
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
    // A screen left open across its Work's purge names a branch that is gone: the adapter
    // answers it `left_out purged`, as it does a purge that lands inside the command.
    identity: branchIdentityOrGone,
    run: async ({ request, envelope, access }) => {
      const commandId = request.commandId as CommandId;
      const lookup = async () =>
        replay<UndoDiscardResult>(
          await deps.documentSync.draftReview.lookupCommand(envelope),
          commandId,
        );
      const recorded = await lookup();
      if (recorded) return recorded;
      // A grant denied here is about who is acting: a 404.
      const refused = async (): Promise<UndoDiscardAnswer> =>
        (await lookup()) ?? Promise.reject(createError({ statusCode: 404, message: "Not found" }));
      const grants: FileGrant<"edit" | "command">[] = [];
      for (const documentId of access
        ? await deps.documentSync.draftReview.commandDocuments.ofDiscard({
            discardCommandId: request.discardCommandId as CommandId,
            accountId: input.userId,
            branchId: input.branchId,
          })
        : []) {
        const grant = await documentGrant(deps, input, documentId, access?.owner ?? null);
        if (unseen(grant)) continue;
        if (isFileAccessDenied(grant)) return refused();
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
      return result.ok ? result.value : refused();
    },
  });
}

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
    branchId: input.branchId,
    selectors: { itemKey: request.itemKey, documentId: input.documentId },
    body,
  });
  return commandIngress(deps, input, envelope, async ({ owner }) => {
    // An item the branch holds nothing on has no row to resolve or authorize: the kernel says what
    // became of it.
    const item = await commandItem(deps, input);
    return {
      grants: item && owner ? await discardGrants(deps, { ...input, owner, items: [item] }) : [],
      effect: () =>
        deps.documentSync.draftReview.discardItem({
          item: item ?? {
            branchId: input.branchId,
            itemKey: request.itemKey as DraftItemKey,
            documentId: input.documentId,
            origin: "edited",
          },
          ends: request.ends,
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
    // A branch that is not the owner's active one has nothing to authorize: the Discard answers
    // `already` for every item.
    const listed = owner ? await deps.documentSync.draftReview.listItems({ owner }) : null;
    const live = owner && listed?.branchId === branchId ? { owner, items: listed.items } : null;
    const discard = (selection: DiscardSelection) => () =>
      deps.documentSync.draftReview.discardBranch({
        branchId,
        selection,
        userId: input.userId,
        envelope,
      });
    if ("all" in request)
      return {
        grants: live ? await discardGrants(deps, { ...input, ...live }) : [],
        effect: discard({ kind: "whole" }),
      };
    const byNode = new Map((live?.items ?? []).map((item) => [item.documentId as string, item]));
    return {
      grants: live
        ? await discardGrants(deps, {
            ...input,
            ...live,
            items: request.items.flatMap((entry) => byNode.get(entry.node) ?? []),
          })
        : [],
      effect: discard({
        kind: "items",
        items: request.items.map((entry) => ({
          documentId: entry.node as DocumentId,
          origin: byNode.get(entry.node)?.origin ?? "edited",
          ends: entry.ends,
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
    draftId: item.draftId,
    hasDraft: item.hasDraft,
    textChanges: item.textChanges,
    origin: item.origin,
    isNew: item.isNew,
    binary: item.binary,
    wholeItem: item.wholeItem,
    tree: item.tree
      ? {
          ...(item.tree.movedFrom
            ? { movedFrom: reviewContextLocation(item.tree.movedFrom) ?? undefined }
            : {}),
          ...(item.tree.deleted ? { deleted: true as const } : {}),
        }
      : null,
    documentName: item.documentName,
    contextLocation: reviewContextLocation(item.path),
    deletedLive: item.deletedLive,
    ...(item.deletedFrom
      ? { deletedFrom: reviewContextLocation(item.deletedFrom) ?? undefined }
      : {}),
    actorThreads: item.actorThreadIds.map((threadId) => ({
      threadId,
      title: threadTitles.get(threadId) ?? null,
    })),
    unattributed: item.unattributed,
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
    if (cause instanceof ApplyClickMalformed)
      throw createError({ statusCode: 400, message: "Invalid Apply request" });
    // The click is ahead of what the server holds; nothing was stored and the client sends it again.
    if (cause instanceof ApplyClickUnsynced)
      throw createError({
        statusCode: 503,
        message: "Apply is waiting for the draft to sync",
        data: { retryable: true },
      });
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
