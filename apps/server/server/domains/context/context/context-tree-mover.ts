/**
 * ContextTreeMover owns filesystem move/delete semantics after URI routing.
 * It prepares ContextLocationToken CAS plans (same-path guard, exact target
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
  type Filetype,
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
  ContextLocationOptions,
  ContextMoveResult,
  ContextScheme,
} from "../ports/context-port.js";
import type {
  ContextLocationToken,
  PreparedContextMove,
} from "../ports/context-tree-mutation-store.js";
import { adapterFaultToContextError } from "./adapter-fault.js";
import {
  type ContextOperationReceipts,
  deleteCommand,
  moveCommand,
} from "./context-operation-receipts.js";
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

/** The node a command acts on: the one the caller named, at the id it has now. */
function nodeOf(options: { expected: ContextEntryRef; nodeId?: string }): ContextEntryRef {
  return { kind: options.expected.kind, nodeId: options.nodeId ?? options.expected.nodeId };
}

/** The writer-location command's options; `inTransaction` runs inside the locks. */
type LocationChangePolicy = ContextLocationOptions & {
  resolveDestination?: () => Promise<Result<ContextTreeDispatch, ContextError>>;
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
   * Move the node `options.expected` names. `source` is only where the caller found it, which
   * decides the locks; the row itself is found by id under them.
   */
  async commitWriterLocation(
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch | null,
    options: LocationChangePolicy,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    const { operationId } = options;
    if (operationId) {
      if (!this.receipts) return Err({ code: "invalid_operation", uri: source.canonical });
      return this.receipts.execute(operationId, moveCommand(options), source.canonical, () =>
        this.commitWriterLocation(source, destination, { ...options, operationId: undefined }),
      );
    }
    return this.changeLocation(source, destination, options);
  }

  /**
   * `folder` is where the node lands, or null for the folder it is in; neither the folder nor the
   * leaf is known until the node is read under the locks, so the finished path is built there.
   */
  private async changeLocation(
    source: ContextTreeDispatch,
    folder: ContextTreeDispatch | null,
    policy: LocationChangePolicy,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    await this.moveLinks?.flush(source);
    let lockedDestination = folder ?? source;
    const destinationResolver = policy.resolveDestination;
    const scopeOf = (dispatch: ContextTreeDispatch) => ({
      scheme: dispatch.scheme,
      workId: isWorkScopedScheme(dispatch.scheme) ? dispatch.workScopeId : null,
    });
    return this.commandExecutor
      .run(
        async () => {
          let into = folder ?? source;
          if (policy.resolveDestination) {
            const current = await policy.resolveDestination();
            if (!current.ok) return current;
            // Resolve again after namespace locks. A concurrent cross-namespace move
            // requires a fresh attempt, never locks acquired in a different order.
            if (
              current.value.scheme !== lockedDestination.scheme ||
              current.value.workScopeId !== lockedDestination.workScopeId
            )
              return namespaceChanged(into.canonical);
            into = current.value;
          }
          const sourceToken = await this.inspectSource(source, nodeOf(policy));
          if (!sourceToken.ok) return sourceToken;
          // The node's own folder and name, as the locks see them, fill what the caller left out.
          const leaf = policy.name ?? basename(sourceToken.value.path);
          if (!leaf) return Err({ code: "invalid_operation", uri: into.canonical });
          const path = joinPath(folder ? into.path : dirname(sourceToken.value.path), leaf);
          const destination = { ...into, path, canonical: uriAt(into, path) };
          if (
            policy.authorizeDestination &&
            !(await policy.authorizeDestination(destination.canonical))
          )
            return Err({ code: "permission_denied", uri: destination.canonical });
          if (!source.adapter.capabilities.writable || !destination.adapter.capabilities.writable) {
            return Err({ code: "permission_denied", uri: destination.canonical });
          }
          if (!source.adapter.tree || !destination.adapter.tree) {
            return Err({ code: "permission_denied", uri: destination.canonical });
          }

          const prepared = await this.prepareMove(sourceToken.value, source, destination, policy);
          if (!prepared.ok) return prepared;
          if (
            prepared.value.expectedTarget.state === "occupied" &&
            prepared.value.expectedTarget.token.nodeId === prepared.value.source.nodeId &&
            prepared.value.expectedTarget.token.sourceId === prepared.value.source.sourceId
          ) {
            if (!policy.position)
              return prepared.value.source.kind === "file"
                ? this.graduateInPlace(source, prepared.value.source, destination)
                : Ok({
                    movedNodeId: prepared.value.source.nodeId,
                    destinationPath: prepared.value.source.path,
                    destinationUri: uriAt(destination, prepared.value.source.path),
                  });
          }
          const result = await this.commitPreparedMove(destination, prepared.value, policy);
          if (!result.ok) return result;
          const moved: ContextMoveResult = {
            movedNodeId: result.value.movedNodeId,
            ...(result.value.linkUpdate ? { linkUpdate: result.value.linkUpdate } : {}),
            ...(result.value.locationVersion
              ? { locationVersion: result.value.locationVersion }
              : {}),
            destinationPath: result.value.path,
            destinationUri: uriAt(destination, result.value.path),
          };
          await policy.inTransaction?.(moved);
          return Ok(moved);
        },
        destinationResolver
          ? async () => {
              const current = await destinationResolver();
              if (current.ok) lockedDestination = current.value;
              return [source, lockedDestination].map(scopeOf);
            }
          : [source, folder ?? source].map(scopeOf),
      )
      .catch((error) => lifecycleCommandFailure(error, source.canonical));
  }

  private commitPreparedMove(
    destination: ContextTreeDispatch,
    prepared: PreparedContextMove,
    policy: LocationChangePolicy,
  ) {
    return callAdapter(
      destination.canonical,
      () =>
        destination.adapter.tree?.commitPreparedMove({
          ...prepared,
          linkNoteProjectId: this.moveLinks?.linkNoteProjectId,
          ...(policy.position ? { position: policy.position } : {}),
        }) ?? Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
  }

  private async graduateInPlace(
    source: ContextTreeDispatch,
    token: ContextLocationToken,
    destination: ContextTreeDispatch,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    if (token.kind !== "file") return Err({ code: "invalid_operation", uri: source.canonical });
    const result = await callAdapter(
      source.canonical,
      () =>
        source.adapter.tree?.commitProvisionalGraduation(token) ??
        Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
    if (!result.ok) return result;
    return Ok({
      movedNodeId: token.nodeId,
      destinationPath: token.path,
      destinationUri: uriAt(destination, token.path),
    });
  }

  async delete(
    target: ContextTreeDispatch,
    options: ContextDeleteOptions,
  ): Promise<Result<DeleteContextEntryResult, ContextError>> {
    if (options.operationId) {
      if (!this.receipts) return Err({ code: "invalid_operation", uri: target.canonical });
      return this.receipts.execute(
        options.operationId,
        deleteCommand(options),
        target.canonical,
        () => this.delete(target, { ...options, operationId: undefined }),
      );
    }
    return this.commandExecutor
      .run(
        () => this.deleteCommand(target, options),
        [
          {
            scheme: target.scheme,
            workId: isWorkScopedScheme(target.scheme) ? target.workScopeId : null,
          },
        ],
      )
      .catch((error) => lifecycleCommandFailure(error, target.canonical));
  }

  private async deleteCommand(
    target: ContextTreeDispatch,
    options: ContextDeleteOptions,
  ): Promise<Result<DeleteContextEntryResult, ContextError>> {
    if (!target.adapter.capabilities.writable || !target.adapter.tree) {
      return Err({ code: "permission_denied", uri: target.canonical });
    }

    const token = await this.inspectSource(target, nodeOf(options), options.onlyAt);
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
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch,
    policy: LocationChangePolicy,
  ): Promise<Result<PreparedContextMove, ContextError>> {
    if (!basename(sourceNode.path))
      return Err({ code: "invalid_operation", uri: source.canonical });

    const destinationSourceId = await this.destinationSourceId(destination);
    if (!destinationSourceId.ok) return destinationSourceId;

    let destinationParentToken: Extract<ContextLocationToken, { kind: "directory" }> | undefined;
    const createFolders = policy.destinationParent?.createFolders ?? [];
    if (!createFolders.every((segment) => validateContextEntryName(segment).ok))
      return Err({ code: "invalid_operation", uri: destination.canonical });
    if (policy.destinationParent) {
      const parentParts = dirname(destination.path).split("/").filter(Boolean);
      if (
        createFolders.some(
          (segment, index) =>
            segment !== parentParts[parentParts.length - createFolders.length + index],
        )
      )
        return Err({ code: "invalid_operation", uri: destination.canonical });
      const anchorPath = parentParts.slice(0, parentParts.length - createFolders.length).join("/");
      const parent = await this.inspect({ ...destination, path: anchorPath });
      if (!parent.ok) return parent;
      if (
        parent.value?.kind !== "directory" ||
        (policy.destinationParent.kind === "folder" &&
          parent.value.nodeId !== policy.destinationParent.folderId) ||
        (policy.destinationParent.kind === "root" && parent.value.path !== "")
      )
        return Err({ code: "destination_missing", uri: destination.canonical });
      destinationParentToken = parent.value;
    }
    const exactPath = destination.path.split("/").filter(Boolean).join("/");
    if (!basename(exactPath)) return Err({ code: "invalid_operation", uri: destination.canonical });
    let targetPath = exactPath;
    let fileDestination:
      | {
          destinationFiletype: Filetype | null;
          destinationFilename: { name: string; extension: string };
        }
      | undefined;
    if (sourceNode.kind === "file") {
      const { extension, filetype } = sourceNode;
      const targetParts = storedFilename(basename(targetPath), { extension });
      if (!targetParts.ok) return Err({ ...targetParts.error, uri: destination.canonical });
      fileDestination = {
        // A storage-backed file keeps its type unless the extension changes.
        destinationFiletype:
          filetype === null && targetParts.filename.extension === extension
            ? null
            : targetParts.filename.filetype,
        destinationFilename: targetParts.filename,
      };
      targetPath = joinPath(dirname(targetPath), targetParts.name);
    }
    const existingTarget = await this.inspect({ ...destination, path: targetPath });
    if (!existingTarget.ok) return existingTarget;

    if (sourceNode.kind === "directory") {
      const targetParentPath = dirname(targetPath);
      if (
        sourceNode.sourceId === destinationSourceId.value &&
        (targetParentPath === sourceNode.path || targetParentPath.startsWith(`${sourceNode.path}/`))
      ) {
        return Err({ code: "invalid_operation", uri: destination.canonical });
      }
    }

    const expectedTarget = existingTarget.value
      ? ({ state: "occupied", token: existingTarget.value } as const)
      : ({ state: "absent" } as const);
    const prepared = {
      source: sourceNode,
      destinationSourceId: destinationSourceId.value,
      ...(destinationParentToken ? { destinationParentToken } : {}),
      ...(createFolders.length ? { destinationCreateFolders: createFolders } : {}),
      destinationPath: targetPath,
      expectedTarget,
    };
    if (sourceNode.kind === "directory") return Ok({ ...prepared, source: sourceNode });
    if (!fileDestination) throw new Error("a file move names its destination");
    return Ok({
      ...prepared,
      source: sourceNode,
      ...fileDestination,
      graduateProvisionalName: true,
    });
  }

  private async inspect(
    dispatch: ContextTreeDispatch,
  ): Promise<Result<ContextLocationToken | null, ContextError>> {
    const tree = dispatch.adapter.tree;
    if (!tree) return Err({ code: "permission_denied", uri: dispatch.canonical });
    return callAdapter(dispatch.canonical, () => tree.inspectMovable(dispatch.path));
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
