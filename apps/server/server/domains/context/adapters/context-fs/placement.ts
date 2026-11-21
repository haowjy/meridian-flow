import type { DraftId } from "@meridian/contracts";
/**
 * Where a ContextFS adapter's writes land, as a strategy (contract §2.3, §6.1). The port factory
 * decides the placement once (`placementFor`); ContextFS delegates the commands whose meaning
 * differs: reads' tree view, `ensureTrackedDocument`, `writeBinary`, and the
 * refusals a draft placement makes (a draft never seeds live Yjs). A drafted write is a record
 * of the Work's branch (`{ draft: branchId }`), which the command transaction ensures and
 * locks; a live one is a live record.
 */

import type { DocumentId, DraftOwner, ThreadId, UserId } from "@meridian/contracts";
import { entrySegment, renderFilename } from "@meridian/contracts/protocol";
import { LIVE } from "@meridian/project-tree";
import { Ok, type Result } from "../../../../shared/result.js";
import type { MarkdownDocumentStore } from "../../../collab/index.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault, ContextEnsureTrackedOptions } from "../../ports/context-adapter.js";
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type { ContextScheme, ContextWriteBinaryOptions } from "../../ports/context-port.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { type CreateTarget, resolveBinaryTarget, resolveCreateTarget } from "./create-target.js";
import type { LiveCreate } from "./live-create.js";
import { actorOf, type SourceTree, type TreeWriteTarget, viewOfBranch } from "./tree-writes.js";

/**
 * People and auto-apply chats are live. A draft-mode chat on a drafted source is a draft
 * placement: reads see the chat's draft, and creates are records of it, written under its
 * owner's lock, which the command transaction takes.
 */
export interface BranchPlacement {
  owner: DraftOwner;
  draftId: DraftId;
  threadId: ThreadId;
  userId: UserId;
}

export type ContextPlacement =
  | { kind: "live"; branch?: BranchPlacement }
  | ({ kind: "draft" } & BranchPlacement);

/** Commands only a live placement runs. */
export type LiveOnlyCommand = "take a whole-file write" | "create a file with text";

/** The draft a drafted tree command is made in: it, its owner, its thread and user. */
export type BranchCommandOwner = {
  owner: DraftOwner;
  draftId: DraftId;
  threadId: ThreadId;
  userId: UserId;
};

export interface CreatePlacement {
  readonly kind: ContextPlacement["kind"];
  /** What reads see, resolved once per command; a read never makes a branch. */
  readView(version: "draft" | "live" | undefined): Promise<TreeView>;
  /** The fault a live-only command meets here, or null when it may run. */
  refuse(command: LiveOnlyCommand): AdapterFault | null;
  /**
   * A tracked document at `path`: the one the path reaches, or a create where it reaches none, a
   * folder or a stored file (a twin beside it), or where `options.beside` asks for a new one.
   */
  ensureTracked(
    path: string,
    options?: ContextEnsureTrackedOptions,
  ): Promise<Result<{ documentId: string; created: boolean; path: string }, AdapterFault>>;
  writeBinary(
    path: string,
    options: ContextWriteBinaryOptions,
  ): Promise<
    Result<{ documentId: string; placement: ContextPlacement["kind"]; path: string }, AdapterFault>
  >;
  /** The branch a drafted move or delete is made in, or null where this adapter has none. */
  readonly branchOwner: BranchCommandOwner | null;
}

export interface CreatePlacementDeps {
  store: ContextDocumentStore;
  tree: SourceTree;
  executor: ResultAwareCommandExecutor<AdapterFault>;
  documentSync: Pick<MarkdownDocumentStore, "ensureDocumentAuthority">;
  arrivals?: Pick<DocumentArrivals, "lockNamespaces">;
  liveCreate: LiveCreate;
  scheme: ContextScheme;
}

export function createPlacement(
  placement: ContextPlacement,
  deps: CreatePlacementDeps,
): CreatePlacement {
  return placement.kind === "live"
    ? livePlacement(placement, deps)
    : draftPlacement(placement, deps);
}

/** The tracked document an ensure reuses at its target: the one its leaf reaches, if any. */
async function existingTracked(
  deps: CreatePlacementDeps,
  target: TreeWriteTarget,
  at: CreateTarget,
  options: ContextEnsureTrackedOptions | undefined,
): Promise<{ documentId: string; path: string } | null> {
  if (options?.beside) return null;
  const leaf = entrySegment(renderFilename(at.name, at.extension), at.suffix);
  const existing = await deps.tree.find(target, at.dir, leaf, options?.into);
  if (existing?.kind !== "document") return null;
  await deps.documentSync.ensureDocumentAuthority(existing.id as DocumentId);
  return { documentId: existing.id, path: existing.path };
}

/** A binary file at the path, as a record of the view; its bytes are already in storage. */
async function createBinary(
  deps: CreatePlacementDeps,
  target: TreeWriteTarget,
  path: string,
  options: ContextWriteBinaryOptions,
): Promise<Result<{ documentId: string; path: string }, AdapterFault>> {
  const resolved = resolveBinaryTarget(deps.scheme, path, options);
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
  return created.ok
    ? Ok({ documentId: created.value.id, path: created.value.path.join("/") })
    : created;
}

function livePlacement(
  placement: Extract<ContextPlacement, { kind: "live" }>,
  deps: CreatePlacementDeps,
): CreatePlacement {
  const { executor } = deps;
  return {
    kind: "live",
    readView: (version) =>
      version !== "live" && placement.branch
        ? Promise.resolve({ kind: "branch" as const, branchId: placement.branch.draftId })
        : Promise.resolve(LIVE_TREE),
    refuse: () => null,
    ensureTracked(path, options) {
      return executor.run<{ documentId: string; created: boolean; path: string }>(async () => {
        const resolved = resolveCreateTarget(deps.scheme, path, options);
        if (!resolved.ok) return resolved;
        const target = { view: LIVE, actor: actorOf(options?.origin) };
        const existing = await existingTracked(deps, target, resolved.value, options);
        if (existing) return Ok({ ...existing, created: false });
        const created = await deps.liveCreate.atomically(resolved.value, null, {
          ...(options ? { options } : {}),
          ...(options?.into ? { into: options.into } : {}),
        });
        if (!created.ok) return created;
        await options?.recordCreate?.({
          documentId: created.value.documentId as DocumentId,
          record: created.value.record,
          folders: created.value.folders,
          path: created.value.path,
        });
        return Ok({
          documentId: created.value.documentId,
          created: true,
          path: created.value.path,
        });
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
        return Ok({ ...created.value, placement: "live" as const });
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
  const inBranch = <T>(operation: (branch: { id: DraftId }) => Promise<Result<T, AdapterFault>>) =>
    executor.runInBranch(owner, (branch) => operation({ id: branch.id }));
  return {
    kind: "draft",
    readView: (version) =>
      version === "live"
        ? Promise.resolve(LIVE_TREE)
        : Promise.resolve({ kind: "branch" as const, branchId: placement.draftId }),
    refuse: (operation) => ({
      code: "invalid_operation",
      message: `In draft mode, you can't ${operation}; create the file empty and write into it`,
    }),
    ensureTracked(path, options) {
      return inBranch<{ documentId: string; created: boolean; path: string }>(async (branch) => {
        const resolved = resolveCreateTarget(deps.scheme, path, options);
        if (!resolved.ok) return resolved;
        const { dir, name, extension, filetype } = resolved.value;
        const target = {
          view: viewOfBranch(branch.id),
          actor: actorOf(options?.origin),
        };
        const existing = await existingTracked(deps, target, resolved.value, options);
        if (existing) return Ok({ ...existing, created: false });
        const created = await tree.create(target, {
          dir,
          filename: renderFilename(name, extension),
          kind: "document",
          filetype,
          ...(options?.into ? { into: options.into } : {}),
          ...(options?.metadata ? { metadata: options.metadata } : {}),
        });
        if (!created.ok) return created;
        // The create's admission made its authority and its Work text draft.
        const documentId = created.value.id as DocumentId;
        await options?.recordCreate?.({
          documentId,
          record: created.value.record,
          folders: created.value.folders,
          draftBranchId: branch.id,
          path: created.value.path.join("/"),
        });
        return Ok({ documentId, created: true, path: created.value.path.join("/") });
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
        return created.ok ? Ok({ ...created.value, placement: "draft" as const }) : created;
      });
    },
    branchOwner: owner,
  };
}

function branchOwnerOf(placement: BranchPlacement): BranchCommandOwner {
  return {
    owner: placement.owner,
    draftId: placement.draftId,
    threadId: placement.threadId,
    userId: placement.userId,
  };
}
