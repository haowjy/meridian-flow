/**
 * Where a ContextFS adapter's creates land, as a strategy (contract §2.3, §6.1). The port
 * factory decides the placement once (`placementFor`); ContextFS delegates the commands
 * whose meaning differs: reads' tree view, `ensureTrackedDocument`, `writeBinary`,
 * `retractCreate`, the refusals a draft placement makes (a draft never seeds live
 * Yjs, and an empty hidden folder would have no use), and a draft placement's moves and
 * deletes, which are facts in the Work's branch (D26).
 */

import type { DocumentId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { RetractionCause } from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { Branches } from "../../../collab/domain/branches.js";
import type { MarkdownDocumentStore } from "../../../collab/index.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type {
  BranchChangeAuthor,
  BranchTreePort,
  EnsuredBranch,
  RecordedBranchTreeChange,
} from "../../ports/branch-tree.js";
import type { AdapterFault, ContextEnsureTrackedOptions } from "../../ports/context-adapter.js";
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type { ContextWriteBinaryOptions } from "../../ports/context-port.js";
import type { BranchTreeChange, BranchTreeFault } from "../../tree/branch-tree-changes.js";
import type { CreateFault } from "../../tree/hidden-node-types.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { binaryTrackedWriteFault } from "./bound-writes.js";
import { resolveBinaryTarget, resolveCreateTarget } from "./create-target.js";
import type { LiveCreate } from "./live-create.js";

/**
 * People and auto-apply chats are live. A draft-mode chat on a drafted source is
 * a draft placement: reads see the Work's active branch (live while it has none), and
 * creates make hidden rows in that branch, which the command transaction ensures.
 */
export interface BranchPlacement {
  workId: WorkId;
  threadId: ThreadId;
  userId: UserId;
  branches: Pick<Branches, "viewForWork">;
  tree: BranchTreePort;
}

export type ContextPlacement =
  | { kind: "live"; branch?: BranchPlacement }
  | ({ kind: "draft" } & BranchPlacement);

/** Commands only a live placement runs. */
export type LiveOnlyCommand =
  | "take a whole-file write"
  | "create a file with text"
  | "create an untitled file"
  | "make an empty folder"
  | "receive a copy";

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
  /** Reverse a create (§12.5): `live` asks the caller to delete; a branch create retracts here. */
  retract(
    documentId: string,
    cause: RetractionCause,
  ): Promise<Result<{ placement: ContextPlacement["kind"] }, AdapterFault>>;
  /** A draft placement's moves and deletes; null for a live one, whose go through the mover. */
  readonly branchTree: BranchTreeCommands | null;
}

/** A drafted move or delete, recorded by the caller in the same transaction. */
type BranchTreeCommand = {
  documentId: DocumentId;
  changedBy: BranchChangeAuthor;
  record(change: RecordedBranchTreeChange): Promise<void>;
  position?: import("@meridian/contracts/protocol").ContextSiblingPosition;
};

export interface BranchTreeCommands {
  /** `moved: false` when the branch already has it there. */
  move(
    target: { dir: readonly string[]; name: string; extension: string },
    command: BranchTreeCommand & {
      /** The source the branch has it in now, whose namespace the command also takes. */
      fromSourceId: string;
    },
  ): Promise<Result<{ moved: boolean; name?: string; extension?: string }, AdapterFault>>;
  delete(command: BranchTreeCommand): Promise<Result<void, AdapterFault>>;
}

export interface CreatePlacementDeps {
  store: ContextDocumentStore;
  executor: ResultAwareCommandExecutor<AdapterFault>;
  documentSync: Pick<MarkdownDocumentStore, "repairDocumentAuthority">;
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

function livePlacement(
  placement: Extract<ContextPlacement, { kind: "live" }>,
  deps: CreatePlacementDeps,
): CreatePlacement {
  const { store, executor } = deps;
  return {
    kind: "live",
    readView: (version) =>
      version !== "live" && placement.branch
        ? placement.branch.branches.viewForWork(placement.branch.workId)
        : Promise.resolve(LIVE_TREE),
    refuse: () => null,
    ensureTracked(path, options) {
      return executor.run(async () => {
        const target = resolveCreateTarget(path, options);
        if (!target.ok) return target;
        const folderId = await store.ensureFolderPath(target.value.dir);
        const existing = await store.findDocument(
          folderId,
          target.value.name,
          target.value.extension,
        );
        if (existing?.fileType != null) return Err(binaryTrackedWriteFault(path));
        if (existing) {
          await deps.documentSync.repairDocumentAuthority(existing.id as DocumentId);
          return Ok({ documentId: existing.id, created: false as boolean });
        }
        // Empty: a hidden document at the path is revealed with no lease (§6.3 step 3).
        const created = await deps.liveCreate.atomically(
          { ...target.value, folderId },
          { kind: "empty" },
          { options },
        );
        if (!created.ok) return created;
        await options?.recordCreate?.({
          documentId: created.value.document.id as DocumentId,
          change: { destination: "live", before: null },
        });
        return Ok({ documentId: created.value.document.id, created: true });
      });
    },
    writeBinary(path, options) {
      return executor.run(async () => {
        const target = resolveBinaryTarget(path, options);
        if (!target.ok) return target;
        const { dir, name, extension } = target.value;
        const folderId = await store.ensureFolderPath(dir);
        const doc = await store.createBinaryDocument({
          id: options.documentId,
          folderId,
          name,
          extension,
          fileType: options.fileType,
          storageUrl: options.storageUrl,
          mimeType: options.mimeType,
          sizeBytes: options.sizeBytes,
          ...(options.metadata ? { metadata: options.metadata } : {}),
        });
        return Ok({ documentId: doc.id, placement: "live" as const });
      });
    },
    retract: async () => Ok({ placement: "live" as const }),
    branchTree: placement.branch ? branchTreeCommands(placement.branch, executor) : null,
  };
}

function draftPlacement(
  placement: Extract<ContextPlacement, { kind: "draft" }>,
  deps: CreatePlacementDeps,
): CreatePlacement {
  const { executor } = deps;
  const work = branchWork(placement);
  /** A command in the drafting Work's branch, which the transaction ensures and locks. */
  const inBranch = <T>(operation: (branch: EnsuredBranch) => Promise<Result<T, AdapterFault>>) =>
    executor.runInBranch({ ...work, mode: "ensure" }, (branch) =>
      operation({ id: branch.id, workId: placement.workId }),
    );
  return {
    kind: "draft",
    readView: (version) =>
      version === "live"
        ? Promise.resolve(LIVE_TREE)
        : placement.branches.viewForWork(placement.workId),
    refuse: (operation) => ({
      code: "invalid_operation",
      message: `In draft mode, you can't ${operation}; create the file empty and write into it`,
    }),
    ensureTracked(path, options) {
      return inBranch(async (branch) => {
        const target = resolveCreateTarget(path, options);
        if (!target.ok) return target;
        const { dir, name, extension, filetype } = target.value;
        const created = await placement.tree.createInBranch({
          branch,
          dir,
          name,
          extension,
          node: {
            kind: "tracked",
            filetype,
            ...(options?.metadata ? { metadata: options.metadata } : {}),
          },
          createdBy: { threadId: placement.threadId },
        });
        if (!created.ok) return Err(createFault(created.error));
        if (created.value.kind === "created") {
          await options?.recordCreate?.({
            documentId: created.value.documentId,
            change: {
              destination: "draft",
              branchId: branch.id,
              before: { row: false, created: false, moved: null, deleted: false },
              after: { row: true, created: true, moved: null, deleted: false },
            },
          });
          return Ok({ documentId: created.value.documentId, created: true as boolean });
        }
        if (created.value.binary) return Err(binaryTrackedWriteFault(path));
        await deps.documentSync.repairDocumentAuthority(created.value.documentId);
        return Ok({ documentId: created.value.documentId, created: false });
      });
    },
    writeBinary(path, options) {
      // A branch's binary document is its own hidden row holding the branch's object (12b-Q2).
      return inBranch(async (branch) => {
        const target = resolveBinaryTarget(path, options);
        if (!target.ok) return target;
        const { dir, name, extension } = target.value;
        const created = await placement.tree.createInBranch({
          branch,
          dir,
          name,
          extension,
          node: {
            kind: "binary",
            ...(options.documentId ? { documentId: options.documentId } : {}),
            fileType: options.fileType,
            storageUrl: options.storageUrl,
            mimeType: options.mimeType,
            sizeBytes: options.sizeBytes,
            ...(options.metadata ? { metadata: options.metadata } : {}),
          },
          createdBy: { threadId: placement.threadId },
        });
        if (!created.ok) return Err(createFault(created.error));
        return Ok({ documentId: created.value.documentId, placement: "draft" as const });
      });
    },
    branchTree: branchTreeCommands(placement, executor),
    retract(documentId, cause) {
      return executor.run(
        async ({ branch }) => {
          // No active branch: a whole Discard already ended every use.
          if (branch) {
            await placement.tree.retractCreate({
              branch: { id: branch.id, workId: placement.workId },
              documentId,
              cause,
            });
          }
          return Ok({ placement: "draft" as const });
        },
        undefined,
        { branch: { ...work, mode: "existing" } },
      );
    },
  };
}

function branchWork(placement: BranchPlacement) {
  return {
    workId: placement.workId,
    threadId: placement.threadId,
    userId: placement.userId,
  };
}

/** Branch tree changes are independent of whether this source's content writes are live. */
function branchTreeCommands(
  placement: BranchPlacement,
  executor: ResultAwareCommandExecutor<AdapterFault>,
): BranchTreeCommands {
  const work = branchWork(placement);
  return {
    move(target, command) {
      return executor.runInBranch(
        { ...work, mode: "ensure" },
        async (
          active,
        ): Promise<Result<{ moved: boolean; name?: string; extension?: string }, AdapterFault>> => {
          const branch = { id: active.id, workId: placement.workId };
          const moved = await placement.tree.moveInBranch({
            branch,
            documentId: command.documentId,
            ...target,
            ...(command.position ? { position: command.position } : {}),
            changedBy: command.changedBy,
          });
          if (!moved.ok)
            return moved.error.code === "already_there"
              ? Ok({ moved: false })
              : Err(branchTreeFault(moved.error));
          await command.record(recorded(branch, moved.value));
          return Ok({
            moved: true,
            name: moved.value.after.moved?.name,
            extension: moved.value.after.moved?.extension,
          });
        },
        [command.fromSourceId],
      );
    },
    delete(command) {
      return executor.runInBranch({ ...work, mode: "ensure" }, async (active) => {
        const branch = { id: active.id, workId: placement.workId };
        const deleted = await placement.tree.deleteInBranch({
          branch,
          documentId: command.documentId,
          changedBy: command.changedBy,
        });
        if (!deleted.ok) return Err(branchTreeFault(deleted.error));
        await command.record(recorded(branch, deleted.value));
        return Ok(undefined);
      });
    },
  };
}

/** What a path two of a branch's files share answers, to a create and to a read alike. */
export const AMBIGUOUS_PATH_FAULT: AdapterFault = {
  code: "invalid_operation",
  reason: "ambiguous_path",
  message: "Two of this Work's drafts share this path. Review the drafts to keep one.",
};

/** The same clash when one of the two is the draft's own copy of a document deleted live (D79). */
export const OUTLIVED_PATH_FAULT: AdapterFault = {
  code: "invalid_operation",
  reason: "ambiguous_path",
  message:
    "This path names two documents in this draft: a new one in the manuscript, and the one this draft still has that was deleted from the manuscript. Ask the user to rename one.",
};

function recorded(branch: EnsuredBranch, change: BranchTreeChange): RecordedBranchTreeChange {
  return { branchId: branch.id, ...change };
}

function branchTreeFault(fault: Exclude<BranchTreeFault, { code: "already_there" }>): AdapterFault {
  switch (fault.code) {
    case "not_found":
      return { code: "stale_source" };
    case "ambiguous":
      return AMBIGUOUS_PATH_FAULT;
    case "conflict":
      return { code: "conflict", occupantKind: fault.occupantKind };
  }
}

function createFault(fault: CreateFault): AdapterFault {
  return fault.code === "ambiguous"
    ? AMBIGUOUS_PATH_FAULT
    : { code: "conflict", ...(fault.occupantKind ? { occupantKind: fault.occupantKind } : {}) };
}
