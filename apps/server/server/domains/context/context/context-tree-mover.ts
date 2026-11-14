/**
 * ContextTreeMover owns filesystem move/delete semantics after URI routing. A command names its
 * node by id and its area by dispatch, and the mover reads the row, its folder and its name
 * under the locks; the only path it works from is the one it builds there. It prepares ContextLocationToken CAS plans (same-path guard, exact target
 * resolution, type rules, and folder-into-self rejection) and
 * delegates the single durable commit to a ContextTreeMutationStore-backed
 * adapter capability.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import {
  formatParsedContextUri,
  isWorkScopedScheme,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import {
  type ContextEntryRef,
  type DeleteContextEntryResult,
  renderFilename,
  storedFilename,
} from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../shared/result.js";
import { WorkLifecycleUnavailableError } from "../../projects/domain/work-lifecycle.js";
import { LineageScratchUnavailableError } from "../adapters/lineage-scratch-lifecycle.js";
import type { AdapterFault, ContextSchemeAdapter } from "../ports/context-adapter.js";
import {
  type ContextCommandTransaction,
  directContextCommandTransaction,
} from "../ports/context-command-transaction.js";
import type {
  ContextDeleteOptions,
  ContextError,
  ContextLocationChange,
  ContextMoveResult,
  ContextScheme,
} from "../ports/context-port.js";
import type {
  ContextLocationToken,
  PreparedContextMove,
} from "../ports/context-tree-mutation-store.js";
import { adapterFaultToContextError } from "./adapter-fault.js";
import type { ContextOperationReceipts } from "./context-operation-receipts.js";
import { invalidEntryError } from "./invalid-entry-error.js";
import {
  createResultAwareCommandExecutor,
  type ResultAwareCommandExecutor,
} from "./result-aware-command-executor.js";

function lifecycleCommandFailure(error: unknown, uri: string): Result<never, ContextError> {
  if (error instanceof LineageScratchUnavailableError) return Err({ code: "not_found", uri });
  if (error instanceof WorkLifecycleUnavailableError)
    return Err({
      code: "context_unavailable",
      uri,
      reason: `work_${error.state}`,
      workHandle: error.workHandle ?? null,
    });
  throw error;
}

async function callAdapter<T>(
  uri: string,
  op: () => Promise<Result<T, AdapterFault>>,
): Promise<Result<T, ContextError>> {
  let result: Result<T, AdapterFault>;
  try {
    result = await op();
  } catch (error) {
    return Err({
      code: "io_error",
      uri,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!result.ok) return Err(adapterFaultToContextError(result.error, uri));
  return Ok(result.value);
}

/** A router-resolved URI plus the adapter/source scope that owns it. */
export interface ContextTreeDispatch {
  adapter: ContextSchemeAdapter;
  scheme: ContextScheme;
  workScopeId: string | null;
  path: string;
  canonical: string;
}

function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function dirname(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function joinPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .join("/");
}

/** The address of `path` in `dispatch`'s scheme and owner. */
function uriAt(dispatch: ContextTreeDispatch, path: string): string {
  const parsed = parseContextUri(dispatch.canonical);
  if (!parsed.ok) throw new Error("Invalid resolved URI");
  return formatParsedContextUri(dispatch.scheme, path, parsed.value.authority);
}

/** Not final, so no receipt: the resend finds the entry in the namespace it is in now. */
function namespaceChanged(uri: string): Result<never, ContextError> {
  return Err({
    code: "io_error",
    uri,
    message: "The entry moved to another area while the request was in flight",
    reason: "namespace_changed",
  });
}

/** Where a move lands, resolved by the router; the folder is read again under the locks. */
export type ResolvedMoveDestination =
  | { kind: "keep" }
  | { kind: "at"; folder: ContextTreeDispatch; createFolders: readonly string[] }
  | {
      kind: "folder";
      folderId: string;
      createFolders: readonly string[];
      /** The folder's dispatch as it stands now, authorized for the writer. */
      resolve: () => Promise<Result<ContextTreeDispatch, ContextError>>;
    };

export type MoveChange = Omit<ContextLocationChange, "destination"> & {
  destination: ResolvedMoveDestination;
};

/** Coordinates ContextFS tree mutations without owning durable state. */
export class ContextTreeMover {
  private readonly commandExecutor: ResultAwareCommandExecutor<ContextError>;

  constructor(
    transaction: ContextCommandTransaction = directContextCommandTransaction,
    private readonly receipts?: ContextOperationReceipts,
    private readonly moveLinks?: {
      flush(source: ContextTreeDispatch): Promise<void>;
      linkNoteProjectId: string;
    },
  ) {
    this.commandExecutor = createResultAwareCommandExecutor({
      transaction,
      serializeThroughCallbacks: false,
    });
  }

  /**
   * Move the node `node` names. `area` decides the locks and the adapter; the row itself, its
   * folder and its name are read by id under them.
   */
  async commitWriterLocation(
    node: ContextEntryRef,
    area: ContextTreeDispatch,
    change: MoveChange,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    const { operation } = change;
    if (!operation) return this.changeLocation(node, area, change);
    if (!this.receipts) return Err({ code: "invalid_operation", uri: area.canonical });
    return this.receipts.execute(operation.id, operation.command, area.canonical, () =>
      this.changeLocation(node, area, change),
    );
  }

  async flushLinks(source: ContextTreeDispatch): Promise<void> {
    await this.moveLinks?.flush(source);
  }

  private async changeLocation(
    node: ContextEntryRef,
    source: ContextTreeDispatch,
    change: MoveChange,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    if (!change.linksFlushed) await this.flushLinks(source);
    const { destination: where } = change;
    let lockedFolder = where.kind === "at" ? where.folder : source;
    const scopeOf = (dispatch: ContextTreeDispatch) => ({
      scheme: dispatch.scheme,
      workId: isWorkScopedScheme(dispatch.scheme) ? dispatch.workScopeId : null,
    });
    return this.commandExecutor
      .run(
        async () => {
          let folder = lockedFolder;
          if (where.kind === "folder") {
            const current = await where.resolve();
            if (!current.ok) return current;
            // Resolve again after namespace locks. A concurrent cross-namespace move
            // requires a fresh attempt, never locks acquired in a different order.
            if (
              current.value.scheme !== lockedFolder.scheme ||
              current.value.workScopeId !== lockedFolder.workScopeId
            )
              return namespaceChanged(folder.canonical);
            folder = current.value;
          }
          const sourceToken = await this.inspectSource(source, node);
          if (!sourceToken.ok) return sourceToken;

          // The folder the node lands in: the one it is in, a folder read by id, or an address.
          let folderPath = dirname(sourceToken.value.path);
          let anchor: Extract<ContextLocationToken, { kind: "directory" }> | undefined;
          if (where.kind === "folder") {
            const found = await this.inspectFolder(folder, where.folderId);
            if (!found.ok) return found;
            anchor = found.value;
            folderPath = anchor.path;
          } else if (where.kind === "at") {
            folderPath = where.folder.path;
            if (where.createFolders.length) {
              const found = await this.inspect(where.folder);
              if (!found.ok) return found;
              if (found.value?.kind !== "directory")
                return Err({ code: "destination_missing", uri: where.folder.canonical });
              anchor = found.value;
            }
          }
          const createFolders = where.kind === "keep" ? [] : where.createFolders;
          folderPath = joinPath(folderPath, ...createFolders);

          // The leaf is the writer's typed name, else the node's own as the locks see it.
          let leaf = basename(sourceToken.value.path);
          if (change.name !== undefined) {
            const named = validateContextEntryName(change.name);
            if (!named.ok) return Err(invalidEntryError(folder.canonical, named));
            leaf = named.value;
          }
          const path = joinPath(folderPath, leaf);
          const destination = { ...folder, path, canonical: uriAt(folder, path) };
          if (!source.adapter.capabilities.writable || !destination.adapter.capabilities.writable) {
            return Err({ code: "permission_denied", uri: destination.canonical });
          }
          if (!source.adapter.tree || !destination.adapter.tree) {
            return Err({ code: "permission_denied", uri: destination.canonical });
          }

          const prepared = await this.prepareMove(sourceToken.value, destination, {
            folderPath,
            leaf,
            typed: change.name !== undefined,
            anchor,
            createFolders,
          });
          if (!prepared.ok) return prepared;
          if (
            prepared.value.expectedTarget.state === "occupied" &&
            prepared.value.expectedTarget.token.nodeId === prepared.value.source.nodeId &&
            prepared.value.expectedTarget.token.sourceId === prepared.value.source.sourceId
          ) {
            if (!change.position)
              return prepared.value.source.kind === "file"
                ? this.graduateInPlace(source, prepared.value.source, destination)
                : Ok({ destinationUri: uriAt(destination, prepared.value.source.path) });
          }
          const result = await this.commitPreparedMove(destination, prepared.value, change);
          if (!result.ok) return result;
          const moved: ContextMoveResult = {
            ...(result.value.linkUpdate ? { linkUpdate: result.value.linkUpdate } : {}),
            ...(result.value.locationVersion
              ? { locationVersion: result.value.locationVersion }
              : {}),
            destinationUri: uriAt(destination, result.value.path),
          };
          await change.inTransaction?.(moved);
          return Ok(moved);
        },
        where.kind === "folder"
          ? async () => {
              const current = await where.resolve();
              if (current.ok) lockedFolder = current.value;
              return [source, lockedFolder].map(scopeOf);
            }
          : [source, lockedFolder].map(scopeOf),
      )
      .catch((error) => lifecycleCommandFailure(error, source.canonical));
  }

  private commitPreparedMove(
    destination: ContextTreeDispatch,
    prepared: PreparedContextMove,
    change: MoveChange,
  ) {
    return callAdapter(
      destination.canonical,
      () =>
        destination.adapter.tree?.commitPreparedMove({
          ...prepared,
          linkNoteProjectId: this.moveLinks?.linkNoteProjectId,
          ...(change.position ? { position: change.position } : {}),
        }) ?? Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
  }

  private async graduateInPlace(
    source: ContextTreeDispatch,
    token: Extract<ContextLocationToken, { kind: "file" }>,
    destination: ContextTreeDispatch,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    const result = await callAdapter(
      source.canonical,
      () =>
        source.adapter.tree?.commitProvisionalGraduation(token) ??
        Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
    if (!result.ok) return result;
    return Ok({ destinationUri: uriAt(destination, token.path) });
  }

  async delete(
    node: ContextEntryRef,
    area: ContextTreeDispatch,
    options: ContextDeleteOptions,
  ): Promise<Result<DeleteContextEntryResult, ContextError>> {
    const { operation } = options;
    const run = () =>
      this.commandExecutor
        .run(
          () => this.deleteCommand(node, area, options),
          [
            {
              scheme: area.scheme,
              workId: isWorkScopedScheme(area.scheme) ? area.workScopeId : null,
            },
          ],
        )
        .catch((error) => lifecycleCommandFailure(error, area.canonical));
    if (!operation) return run();
    if (!this.receipts) return Err({ code: "invalid_operation", uri: area.canonical });
    return this.receipts.execute(operation.id, operation.command, area.canonical, run);
  }

  private async deleteCommand(
    node: ContextEntryRef,
    target: ContextTreeDispatch,
    options: ContextDeleteOptions,
  ): Promise<Result<DeleteContextEntryResult, ContextError>> {
    if (!target.adapter.capabilities.writable || !target.adapter.tree) {
      return Err({ code: "permission_denied", uri: target.canonical });
    }

    const token = await this.inspectSource(target, node, options.onlyAt);
    if (!token.ok) return token;

    const result = await callAdapter(
      target.canonical,
      () =>
        target.adapter.tree?.commitRecursiveDelete({
          root: token.value,
          mode: "recursive",
          actorUserId: options.origin?.type === "human" ? options.origin.userId : undefined,
          actorThreadId: options.origin?.type === "agent" ? options.origin.threadId : undefined,
          removal: options.removal,
        }) ?? Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
    if (!result.ok) {
      return result.error.code === "stale_source"
        ? Err({ code: "stale_target", uri: target.canonical })
        : result;
    }
    const deleted: DeleteContextEntryResult = {
      status: "deleted",
      uri: uriAt(target, token.value.path),
      removed: result.value.removed,
      availabilityGeneration: result.value.availabilityGeneration,
    };
    await options.inTransaction?.(deleted);
    return Ok(deleted);
  }

  private async prepareMove(
    sourceNode: ContextLocationToken,
    destination: ContextTreeDispatch,
    target: {
      folderPath: string;
      leaf: string;
      /** Whether the writer typed the leaf; otherwise it is the node's own. */
      typed: boolean;
      /** The existing folder the destination hangs from, when it names one. */
      anchor?: Extract<ContextLocationToken, { kind: "directory" }>;
      createFolders: readonly string[];
    },
  ): Promise<Result<PreparedContextMove, ContextError>> {
    const destinationSourceId = await this.destinationSourceId(destination);
    if (!destinationSourceId.ok) return destinationSourceId;

    // What every move shares: the destination claimed at `leafName`, as inspected now.
    const claim = async (leafName: string) => {
      const destinationPath = joinPath(target.folderPath, leafName);
      const existing = await this.inspect({ ...destination, path: destinationPath });
      if (!existing.ok) return existing;
      return Ok({
        destinationSourceId: destinationSourceId.value,
        ...(target.anchor ? { destinationParentToken: target.anchor } : {}),
        ...(target.createFolders.length
          ? { destinationCreateFolders: [...target.createFolders] }
          : {}),
        destinationPath,
        expectedTarget: existing.value
          ? ({ state: "occupied", token: existing.value } as const)
          : ({ state: "absent" } as const),
      });
    };

    if (sourceNode.kind === "directory") {
      if (
        sourceNode.sourceId === destinationSourceId.value &&
        (target.folderPath === sourceNode.path ||
          target.folderPath.startsWith(`${sourceNode.path}/`))
      )
        return Err({ code: "invalid_operation", uri: destination.canonical });
      const claimed = await claim(target.leaf);
      return claimed.ok ? Ok({ ...claimed.value, source: sourceNode }) : claimed;
    }
    // A move without a typed name keeps the stored parts; a typed one follows the row's kind.
    const parts = target.typed
      ? storedFilename(target.leaf, {
          extension: sourceNode.extension,
          editable: sourceNode.filetype !== null,
        })
      : {
          ok: true as const,
          filename: { name: sourceNode.name, extension: sourceNode.extension, filetype: null },
        };
    if (!parts.ok) return Err({ ...parts.error, uri: destination.canonical });
    const { name, extension, filetype } = parts.filename;
    const claimed = await claim(renderFilename(name, extension));
    if (!claimed.ok) return claimed;
    return Ok({
      ...claimed.value,
      source: sourceNode,
      destinationFiletype: filetype,
      destinationFilename: { name, extension },
    });
  }

  private async inspect(
    dispatch: ContextTreeDispatch,
  ): Promise<Result<ContextLocationToken | null, ContextError>> {
    const tree = dispatch.adapter.tree;
    if (!tree) return Err({ code: "permission_denied", uri: dispatch.canonical });
    return callAdapter(dispatch.canonical, () => tree.inspectMovable(dispatch.path));
  }

  /** A destination folder, found by id under the locks; one the locks cannot find is gone. */
  private async inspectFolder(
    dispatch: ContextTreeDispatch,
    folderId: string,
  ): Promise<Result<Extract<ContextLocationToken, { kind: "directory" }>, ContextError>> {
    const tree = dispatch.adapter.tree;
    if (!tree) return Err({ code: "permission_denied", uri: dispatch.canonical });
    const found = await callAdapter(dispatch.canonical, () =>
      tree.inspectNode({ kind: "directory", id: folderId }),
    );
    if (!found.ok) return found;
    if (found.value?.kind !== "directory")
      return Err({ code: "destination_missing", uri: folderId });
    return Ok(found.value);
  }

  /**
   * The node a command acts on, found by id under the locks. A row that is gone is `not_found`; a
   * row now in another Work or area than the one the caller locked is a failure the caller
   * answers by looking the entry up again, since locks cannot be taken in a different order.
   * With `onlyAt`, a row anywhere else is `stale_target`, for a caller that acts only on the
   * place it put the node.
   */
  private async inspectSource(
    dispatch: ContextTreeDispatch,
    node: ContextEntryRef,
    onlyAt?: string,
  ): Promise<Result<ContextLocationToken, ContextError>> {
    const tree = dispatch.adapter.tree;
    if (!tree) return Err({ code: "permission_denied", uri: dispatch.canonical });
    const found = await callAdapter(dispatch.canonical, () =>
      tree.inspectNode({ kind: node.kind === "folder" ? "directory" : "file", id: node.nodeId }),
    );
    if (!found.ok) return found;
    if (found.value === null) return Err({ code: "not_found", uri: dispatch.canonical });
    const scope = await this.destinationSourceId(dispatch);
    if (!scope.ok) return scope;
    const elsewhere =
      found.value.sourceId !== scope.value || (onlyAt !== undefined && found.value.path !== onlyAt);
    if (elsewhere)
      return onlyAt === undefined
        ? namespaceChanged(dispatch.canonical)
        : Err({ code: "stale_target", uri: dispatch.canonical });
    return Ok(found.value);
  }

  private async destinationSourceId(
    destination: ContextTreeDispatch,
  ): Promise<Result<string, ContextError>> {
    const root = await this.inspect({ ...destination, path: "" });
    if (!root.ok) return root;
    if (root.value?.kind !== "directory") {
      return Err({ code: "invalid_operation", uri: destination.canonical });
    }
    return Ok(root.value.sourceId);
  }
}
