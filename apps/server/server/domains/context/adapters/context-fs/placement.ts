/**
 * Where a ContextFS adapter's writes land, as a strategy (contract §2.3, §6.1). The port factory
 * decides the placement once (`placementFor`); ContextFS delegates the commands whose meaning
 * differs: reads' tree view, `ensureTrackedDocument`, `writeBinary`, `retractCreate`, and the
 * refusals a draft placement makes (a draft never seeds live Yjs). A drafted write is a record
 * of the Work's branch (`{ draft: branchId }`), which the command transaction ensures and
 * locks; a live one is a live record.
 */

import type { DocumentId, DraftOwner, ThreadId, UserId } from "@meridian/contracts";
import type { RetractionCause } from "@meridian/contracts/protocol";
import { renderFilename } from "@meridian/contracts/protocol";
import { LIVE } from "@meridian/project-tree";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { Branches } from "../../../collab/domain/branches.js";
import type { DraftPeerShadowAccess, MarkdownDocumentStore } from "../../../collab/index.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault, ContextEnsureTrackedOptions } from "../../ports/context-adapter.js";
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type { ContextWriteBinaryOptions } from "../../ports/context-port.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { binaryTrackedWriteFault } from "./bound-writes.js";
import { resolveBinaryTarget, resolveCreateTarget } from "./create-target.js";
import type { LiveCreate } from "./live-create.js";
import { actorOf, type SourceTree, type TreeWriteTarget, viewOfBranch } from "./tree-writes.js";

/**
 * People and auto-apply chats are live. A draft-mode chat on a drafted source is a draft
 * placement: reads see the Work's active branch (live while it has none), and creates are
 * records of that branch, which the command transaction ensures.
 */
export interface BranchPlacement {
  owner: DraftOwner;
  threadId: ThreadId;
  userId: UserId;
  branches: Pick<Branches, "viewForOwner">;
}

export type ContextPlacement =
  | { kind: "live"; branch?: BranchPlacement }
  | ({ kind: "draft" } & BranchPlacement);

/** Commands only a live placement runs. */
export type LiveOnlyCommand =
  | "take a whole-file write"
  | "create a file with text"
  | "receive a copy";

/** The branch a drafted tree command is made in: the owner, its thread and user. */
export type BranchCommandOwner = { owner: DraftOwner; threadId: ThreadId; userId: UserId };

export interface CreatePlacement {
  readonly kind: ContextPlacement["kind"];
  /** What reads see, resolved once per command; a read never makes a branch. */
  readView(version: "draft" | "live" | undefined): Promise<TreeView>;
  /** The fault a live-only command meets here, or null when it may run. */
  refuse(command: LiveOnlyCommand): AdapterFault | null;
  /** An empty tracked document at `path`: the existing one, or a create. */
  ensureTracked(
    path: string,
    options?: ContextEnsureTrackedOptions,
  ): Promise<Result<{ documentId: string; created: boolean }, AdapterFault>>;
  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<Result<{ documentId: string; placement: ContextPlacement["kind"] }, AdapterFault>>;
  /** Reverse a create whose write failed: a live one goes to Trash, a drafted one is discarded. */
  retract(
    documentId: string,
    path: string,
    cause: RetractionCause,
  ): Promise<Result<{ placement: ContextPlacement["kind"] }, AdapterFault>>;
  /** The branch a drafted move or delete is made in, or null where this adapter has none. */
  readonly branchOwner: BranchCommandOwner | null;
}

export interface CreatePlacementDeps {
  store: ContextDocumentStore;
  tree: SourceTree;
  executor: ResultAwareCommandExecutor<AdapterFault>;
  documentSync: Pick<MarkdownDocumentStore, "ensureDocumentAuthority">;
  drafts: Pick<DraftPeerShadowAccess, "ensureCreatedDocumentDraft" | "retractCreatedDocumentDraft">;
  arrivals?: Pick<DocumentArrivals, "lockNamespaces">;
  liveCreate: LiveCreate;
}

export function createPlacement(
  placement: ContextPlacement,
  deps: CreatePlacementDeps,
): CreatePlacement {
  return placement.kind === "live"
    ? livePlacement(placement, deps)
    : draftPlacement(placement, deps);
}

/** An existing node at the path an ensure or create finds: a tracked document is reused. */
async function existingTracked(
  deps: CreatePlacementDeps,
  target: TreeWriteTarget,
  path: string,
  where: { dir: readonly string[]; filename: string },
): Promise<Result<{ documentId: string } | null, AdapterFault>> {
  const existing = await deps.tree.find(target, where.dir, where.filename);
  if (!existing) return Ok(null);
  if (existing.kind === "file") return Err(binaryTrackedWriteFault(path));
  if (existing.kind === "folder") return Err({ code: "conflict", occupantKind: "folder" });
  await deps.documentSync.ensureDocumentAuthority(existing.id as DocumentId);
  return Ok({ documentId: existing.id });
}

/** A binary file at the path, as a record of the view; its bytes are already in storage. */
async function createBinary(
  deps: CreatePlacementDeps,
  target: TreeWriteTarget,
  path: string,
  options: ContextWriteBinaryOptions,
): Promise<Result<{ documentId: string }, AdapterFault>> {
  const resolved = resolveBinaryTarget(path, options);
  if (!resolved.ok) return resolved;
  const { dir, name, extension } = resolved.value;
  const created = await deps.tree.create(target, {
    dir,
    filename: renderFilename(name, extension),
    kind: "file",
    blob: { storageKey: options.storageUrl, mime: options.mimeType, size: options.sizeBytes },
    ...(options.documentId ? { id: options.documentId } : {}),
    ...(options.hasPreview ? { hasPreview: true } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  return created.ok ? Ok({ documentId: created.value.id }) : created;
}

function livePlacement(
  placement: Extract<ContextPlacement, { kind: "live" }>,
  deps: CreatePlacementDeps,
): CreatePlacement {
  const { executor, tree } = deps;
  return {
    kind: "live",
    readView: (version) =>
      version !== "live" && placement.branch
        ? placement.branch.branches.viewForOwner(placement.branch.owner)
        : Promise.resolve(LIVE_TREE),
    refuse: () => null,
    ensureTracked(path, options) {
      return executor.run<{ documentId: string; created: boolean }>(async () => {
        const resolved = resolveCreateTarget(path, options);
        if (!resolved.ok) return resolved;
        const { dir, name, extension } = resolved.value;
        const target = { view: LIVE, actor: actorOf(options?.origin) };
        const existing = await existingTracked(deps, target, path, {
          dir,
          filename: renderFilename(name, extension),
        });
        if (!existing.ok) return existing;
        if (existing.value) return Ok({ documentId: existing.value.documentId, created: false });
        const created = await deps.liveCreate.atomically(resolved.value, null, { options });
        if (!created.ok) return created;
        await options?.recordCreate?.({
          documentId: created.value.documentId as DocumentId,
          record: created.value.record,
        });
        return Ok({ documentId: created.value.documentId, created: true });
      });
    },
    writeBinary(path, options) {
      return executor.run(async () => {
        const created = await createBinary(
          deps,
          { view: LIVE, actor: actorOf(options.origin) },
          path,
          options,
        );
        if (!created.ok) return created;
        // The upload is an arrival (contract §9.3): its identity and the settlement of an ahead
        // ref waiting at its address publish together, under the namespace key the arrival takes
        // after the list's.
        await deps.liveCreate.arrive([created.value.documentId as DocumentId]);
        return Ok({ documentId: created.value.documentId, placement: "live" as const });
      });
    },
    async retract(documentId, path) {
      return executor.run(async () => {
        const sourceId = await deps.tree.sourceId();
        // The writer may have moved or renamed it since: then it survives.
        await tree.delete(
          { view: LIVE, actor: "system" },
          { node: documentId, kind: "file", fromSourceId: sourceId, onlyAt: path },
        );
        return Ok({ placement: "live" as const });
      });
    },
    branchOwner: placement.branch ? branchOwnerOf(placement.branch) : null,
  };
}

function draftPlacement(
  placement: Extract<ContextPlacement, { kind: "draft" }>,
  deps: CreatePlacementDeps,
): CreatePlacement {
  const { executor, tree } = deps;
  const owner = branchOwnerOf(placement);
  /** A command in the drafting Work's branch, which the transaction ensures and locks. */
  const inBranch = <T>(
    operation: (branch: {
      id: import("@meridian/contracts").BranchId;
    }) => Promise<Result<T, AdapterFault>>,
  ) => executor.runInBranch({ ...owner, mode: "ensure" }, (branch) => operation({ id: branch.id }));
  return {
    kind: "draft",
    readView: (version) =>
      version === "live"
        ? Promise.resolve(LIVE_TREE)
        : placement.branches.viewForOwner(placement.owner),
    refuse: (operation) => ({
      code: "invalid_operation",
      message: `In draft mode, you can't ${operation}; create the file empty and write into it`,
    }),
    ensureTracked(path, options) {
      return inBranch<{ documentId: string; created: boolean }>(async (branch) => {
        const resolved = resolveCreateTarget(path, options);
        if (!resolved.ok) return resolved;
        const { dir, name, extension, filetype } = resolved.value;
        const target = {
          view: viewOfBranch(branch.id),
          actor: actorOf(options?.origin),
        };
        const filename = renderFilename(name, extension);
        const existing = await existingTracked(deps, target, path, { dir, filename });
        if (!existing.ok) return existing;
        if (existing.value) return Ok({ documentId: existing.value.documentId, created: false });
        const created = await tree.create(target, {
          dir,
          filename,
          kind: "document",
          filetype,
          ...(options?.metadata ? { metadata: options.metadata } : {}),
        });
        if (!created.ok) return created;
        const documentId = created.value.id as DocumentId;
        await deps.documentSync.ensureDocumentAuthority(documentId);
        await deps.drafts.ensureCreatedDocumentDraft({ documentId, branchId: branch.id });
        await options?.recordCreate?.({
          documentId,
          record: created.value.record,
          draftBranchId: branch.id,
        });
        return Ok({ documentId, created: true });
      });
    },
    writeBinary(path, options) {
      // A branch's binary document is its own file holding the branch's object (12b-Q2).
      return inBranch(async (branch) => {
        const created = await createBinary(
          deps,
          { view: viewOfBranch(branch.id), actor: actorOf(options.origin) },
          path,
          options,
        );
        return created.ok
          ? Ok({ documentId: created.value.documentId, placement: "draft" as const })
          : created;
      });
    },
    retract(documentId, _path, _cause) {
      return executor.run(
        async ({ branch }) => {
          // No active branch: a whole Discard already ended every use.
          if (branch) {
            const retracted = await deps.drafts.retractCreatedDocumentDraft({
              documentId: documentId as DocumentId,
              branchId: branch.id,
            });
            if (retracted === "retracted")
              await tree.discardDraftedCreate(
                { view: { draft: branch.id }, actor: "system" },
                documentId,
              );
          }
          return Ok({ placement: "draft" as const });
        },
        undefined,
        { branch: { ...owner, mode: "existing" } },
      );
    },
    branchOwner: owner,
  };
}

function branchOwnerOf(placement: BranchPlacement): BranchCommandOwner {
  return { owner: placement.owner, threadId: placement.threadId, userId: placement.userId };
}

/** What a path two of a Work's files share answers, to a create and to a read alike. */
export const AMBIGUOUS_PATH_FAULT: AdapterFault = {
  code: "invalid_operation",
  reason: "ambiguous_path",
  message: "Two of this Work's drafts share this path. Review the drafts to keep one.",
};
