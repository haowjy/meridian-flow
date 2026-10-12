/**
 * Where a ContextFS adapter's creates land, as a strategy (contract §2.3, §6.1). The port
 * factory decides the placement once (`placementFor`); ContextFS delegates the commands
 * whose meaning differs: reads' tree view, `ensureTrackedDocument`, `writeBinary`,
 * `retractCreate`, and the refusals a draft placement makes (a draft never seeds live
 * Yjs, and an empty hidden folder would have no use).
 */
import type { ThreadId, UserId, WorkId } from "@meridian/contracts";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { Drafts } from "../../../collab/domain/drafts.js";
import type { MarkdownDocumentStore } from "../../../collab/index.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault, ContextEnsureTrackedOptions } from "../../ports/context-adapter.js";
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type { ContextWriteBinaryOptions } from "../../ports/context-port.js";
import type { DraftCreatePort, EnsuredDraft } from "../../ports/draft-create.js";
import type { CreateFault } from "../../tree/hidden-node-types.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { binaryTrackedWriteFault } from "./bound-writes.js";
import { resolveBinaryTarget, resolveCreateTarget } from "./create-target.js";
import type { LiveCreate } from "./live-create.js";

/**
 * People and auto-apply Works are live. A draft-mode Work's thread on a drafted source is
 * a draft placement: reads see the Work's active draft (live while it has none), and
 * creates make hidden rows in that draft, which the command transaction ensures.
 */
export type ContextPlacement =
  | { kind: "live" }
  | {
      kind: "draft";
      workId: WorkId;
      threadId: ThreadId;
      userId: UserId;
      drafts: Pick<Drafts, "viewForWork">;
      creates: DraftCreatePort;
    };

/** Commands only a live placement runs. */
export type LiveOnlyCommand =
  | "take a whole-file write"
  | "create a file with text"
  | "create an untitled file"
  | "make an empty folder";

export interface CreatePlacement {
  readonly kind: ContextPlacement["kind"];
  /** What reads see, resolved once per command; a read never makes a draft. */
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
  /** Reverse a create (§12.5): `live` asks the caller to delete; a draft retracts here. */
  retract(
    documentId: string,
  ): Promise<Result<{ placement: ContextPlacement["kind"] }, AdapterFault>>;
}

export interface CreatePlacementDeps {
  store: ContextDocumentStore;
  executor: ResultAwareCommandExecutor<AdapterFault>;
  documentSync: Pick<MarkdownDocumentStore, "ensureDocument">;
  liveCreate: LiveCreate;
}

export function createPlacement(
  placement: ContextPlacement,
  deps: CreatePlacementDeps,
): CreatePlacement {
  return placement.kind === "live" ? livePlacement(deps) : draftPlacement(placement, deps);
}

function livePlacement(deps: CreatePlacementDeps): CreatePlacement {
  const { store, executor } = deps;
  return {
    kind: "live",
    readView: async () => LIVE_TREE,
    refuse: () => null,
    ensureTracked(path, options) {
      return executor.run(async () => {
        const target = resolveCreateTarget(path, options);
        if (!target.ok) return target;
        const folderId = await store.ensureFolderPath(target.value.dir);
        const existing = await store.findDocument(
          LIVE_TREE,
          folderId,
          target.value.name,
          target.value.extension,
        );
        if (existing?.fileType != null) return Err(binaryTrackedWriteFault(path));
        if (existing) {
          await deps.documentSync.ensureDocument(existing.id);
          return Ok({ documentId: existing.id, created: false as boolean });
        }
        // Empty: a hidden document at the path is revealed with no lease (§6.3 step 3).
        const created = await deps.liveCreate.atomically(
          { ...target.value, folderId },
          { kind: "empty" },
          { options },
        );
        return created.ok ? Ok({ documentId: created.value.document.id, created: true }) : created;
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
  };
}

function draftPlacement(
  placement: Extract<ContextPlacement, { kind: "draft" }>,
  deps: CreatePlacementDeps,
): CreatePlacement {
  const { executor } = deps;
  const work = { workId: placement.workId, threadId: placement.threadId, userId: placement.userId };
  /** A command in the drafting Work's draft, which the transaction ensures and locks. */
  const inDraft = <T>(operation: (draft: EnsuredDraft) => Promise<Result<T, AdapterFault>>) =>
    executor.runInDraft({ ...work, mode: "ensure" }, (draft) =>
      operation({ id: draft.id, workId: placement.workId }),
    );
  return {
    kind: "draft",
    readView: (version) =>
      version === "live"
        ? Promise.resolve(LIVE_TREE)
        : placement.drafts.viewForWork(placement.workId),
    refuse: (operation) => ({
      code: "invalid_operation",
      message: `A draft can't ${operation}; create the file empty and write into it`,
    }),
    ensureTracked(path, options) {
      return inDraft(async (draft) => {
        const target = resolveCreateTarget(path, options);
        if (!target.ok) return target;
        const { dir, name, extension, filetype } = target.value;
        const created = await placement.creates.createInDraft({
          draft,
          dir,
          name,
          extension,
          node: {
            kind: "tracked",
            filetype,
            ...(options?.metadata ? { metadata: options.metadata } : {}),
          },
        });
        if (!created.ok) return Err(createFault(created.error));
        if (created.value.kind === "created") {
          return Ok({ documentId: created.value.documentId, created: true as boolean });
        }
        if (created.value.binary) return Err(binaryTrackedWriteFault(path));
        await deps.documentSync.ensureDocument(created.value.documentId);
        return Ok({ documentId: created.value.documentId, created: false });
      });
    },
    writeBinary(path, options) {
      // A draft's binary is its own hidden row holding the draft's object (12b-Q2).
      return inDraft(async (draft) => {
        const target = resolveBinaryTarget(path, options);
        if (!target.ok) return target;
        const { dir, name, extension } = target.value;
        const created = await placement.creates.createInDraft({
          draft,
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
        });
        if (!created.ok) return Err(createFault(created.error));
        return Ok({ documentId: created.value.documentId, placement: "draft" as const });
      });
    },
    retract(documentId) {
      return executor.run(
        async ({ draft }) => {
          // No active draft: a whole Discard already ended every use.
          if (draft) {
            await placement.creates.retractCreate({
              draft: { id: draft.id, workId: placement.workId },
              documentId,
            });
          }
          return Ok({ placement: "draft" as const });
        },
        undefined,
        { draft: { ...work, mode: "existing" } },
      );
    },
  };
}

function createFault(fault: CreateFault): AdapterFault {
  return fault.code === "ambiguous"
    ? {
        code: "invalid_operation",
        message:
          "More than one file has this path in the draft; review the draft to resolve the clash",
      }
    : { code: "conflict", ...(fault.occupantKind ? { occupantKind: fault.occupantKind } : {}) };
}
