import type { DocumentId, DraftId, DraftOwner, ThreadId, UserId } from "@meridian/contracts";
import { entrySegment, renderFilename } from "@meridian/contracts/protocol";
import { LIVE } from "@meridian/project-tree";
import { Ok, type Result } from "../../../../shared/result.js";
import type { ResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { AdapterFault, ContextEnsureTrackedOptions } from "../../ports/context-adapter.js";
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type { ContextScheme, ContextWriteBinaryOptions } from "../../ports/context-port.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import { LIVE_TREE, type TreeView } from "../../tree/tree-view.js";
import { type CreateTarget, resolveBinaryTarget, resolveCreateTarget } from "./create-target.js";
import type { LiveCreate } from "./live-create.js";
import { actorOf, type SourceTree, type TreeWriteTarget, viewOfDraft } from "./tree-writes.js";

export interface DraftPlacement {
  owner: DraftOwner;
  draftId: DraftId;
  threadId: ThreadId;
  userId: UserId;
}

export type ContextPlacement =
  | { kind: "live"; draft?: DraftPlacement }
  | ({ kind: "draft" } & DraftPlacement);

export type LiveOnlyCommand = "take a whole-file write" | "create a file with text";

export type DraftCommandOwner = {
  owner: DraftOwner;
  draftId: DraftId;
  threadId: ThreadId;
  userId: UserId;
};

export interface CreatePlacement {
  readonly kind: ContextPlacement["kind"];
  readView(version: "draft" | "live" | undefined): Promise<TreeView>;
  refuse(command: LiveOnlyCommand): AdapterFault | null;
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
  readonly draftOwner: DraftCommandOwner | null;
}

export interface CreatePlacementDeps {
  store: ContextDocumentStore;
  tree: SourceTree;
  executor: ResultAwareCommandExecutor<AdapterFault>;
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
  return { documentId: existing.id, path: existing.path };
}

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
      version !== "live" && placement.draft
        ? Promise.resolve({ kind: "draft" as const, draftId: placement.draft.draftId })
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
    draftOwner: placement.draft ? draftOwnerOf(placement.draft) : null,
  };
}

function draftPlacement(
  placement: Extract<ContextPlacement, { kind: "draft" }>,
  deps: CreatePlacementDeps,
): CreatePlacement {
  const { executor, tree } = deps;
  const owner = draftOwnerOf(placement);
  const inDraft = <T>(operation: (draft: { id: DraftId }) => Promise<Result<T, AdapterFault>>) =>
    executor.runInDraft(owner, (draft) => operation({ id: draft.id }));
  return {
    kind: "draft",
    readView: (version) =>
      version === "live"
        ? Promise.resolve(LIVE_TREE)
        : Promise.resolve({ kind: "draft" as const, draftId: placement.draftId }),
    refuse: (operation) => ({
      code: "invalid_operation",
      message: `In draft mode, you can't ${operation}; create the file empty and write into it`,
    }),
    ensureTracked(path, options) {
      return inDraft<{ documentId: string; created: boolean; path: string }>(async (draft) => {
        const resolved = resolveCreateTarget(deps.scheme, path, options);
        if (!resolved.ok) return resolved;
        const { dir, name, extension, filetype } = resolved.value;
        const target = {
          view: viewOfDraft(draft.id),
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
        const documentId = created.value.id as DocumentId;
        await options?.recordCreate?.({
          documentId,
          record: created.value.record,
          folders: created.value.folders,
          draftId: draft.id,
          path: created.value.path.join("/"),
        });
        return Ok({ documentId, created: true, path: created.value.path.join("/") });
      });
    },
    writeBinary(path, options) {
      return inDraft(async (draft) => {
        const created = await createBinary(
          deps,
          { view: viewOfDraft(draft.id), actor: actorOf(options.origin) },
          path,
          options,
        );
        return created.ok ? Ok({ ...created.value, placement: "draft" as const }) : created;
      });
    },
    draftOwner: owner,
  };
}

function draftOwnerOf(placement: DraftPlacement): DraftCommandOwner {
  return {
    owner: placement.owner,
    draftId: placement.draftId,
    threadId: placement.threadId,
    userId: placement.userId,
  };
}
