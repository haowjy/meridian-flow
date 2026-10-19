/**
 * ContextTreeMover owns filesystem move/delete semantics after URI routing.
 * It prepares ContextLocationToken CAS plans (same-path guard, exact or Unix
 * target resolution, overwrite/type rules, and folder-into-self rejection) and
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
  type ContextDestinationParent,
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
  ContextMoveOptions,
  ContextMoveResult,
  ContextScheme,
} from "../ports/context-port.js";
import type {
  ContextLocationToken,
  PreparedContextMove,
} from "../ports/context-tree-mutation-store.js";
import { adapterFaultToContextError } from "./adapter-fault.js";
import type { ContextOperationReceipts } from "./context-operation-receipts.js";
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
      workSlug: error.workSlug ?? null,
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

type LocationChangePolicy =
  | { target: "container"; overwrite: boolean; actorUserId?: string }
  | {
      target: "exact";
      overwrite: false;
      graduateProvisionalName: true;
      expected?: ContextLocationOptions["expected"];
      destinationParent?: ContextDestinationParent;
      resolveDestination?: () => Promise<Result<ContextTreeDispatch, ContextError>>;
      authorizeDestination?: (uri: string) => Promise<boolean>;
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

  async move(
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch,
    options?: ContextMoveOptions,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    return this.changeLocation(source, destination, {
      target: "container",
      overwrite: options?.overwrite === true,
      actorUserId: options?.origin?.type === "human" ? options.origin.userId : undefined,
    });
  }

  async commitWriterLocation(
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch,
    options: ContextLocationOptions & {
      resolveDestination?: () => Promise<Result<ContextTreeDispatch, ContextError>>;
    } = {},
  ): Promise<Result<ContextMoveResult, ContextError>> {
    const { expected, operationId, destinationParent, resolveDestination, authorizeDestination } =
      options;
    if (operationId) {
      if (!this.receipts || !expected)
        return Err({ code: "invalid_operation", uri: source.canonical });
      return this.receipts.execute(
        operationId,
        {
          kind: "move",
          sourceUri: source.canonical,
          destinationUri: destination.canonical,
          expected,
          ...(destinationParent ? { destinationParent } : {}),
        },
        () =>
          this.commitWriterLocation(source, destination, { ...options, operationId: undefined }),
      );
    }
    return this.changeLocation(source, destination, {
      target: "exact",
      graduateProvisionalName: true,
      expected,
      overwrite: false,
      destinationParent,
      resolveDestination,
      authorizeDestination,
    });
  }

  private async changeLocation(
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch,
    policy: LocationChangePolicy,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    await this.moveLinks?.flush(source);
    let lockedDestination = destination;
    const destinationResolver = policy.target === "exact" ? policy.resolveDestination : undefined;
    const scopeOf = (dispatch: ContextTreeDispatch) => ({
      scheme: dispatch.scheme,
      workId: isWorkScopedScheme(dispatch.scheme) ? dispatch.workScopeId : null,
    });
    return this.commandExecutor
      .run(
        async () => {
          if (policy.target === "exact" && policy.resolveDestination) {
            const current = await policy.resolveDestination();
            if (!current.ok) return current;
            // Resolve again after namespace locks. A concurrent cross-namespace move
            // requires a fresh attempt, never locks acquired in a different order.
            if (
              current.value.scheme !== lockedDestination.scheme ||
              current.value.workScopeId !== lockedDestination.workScopeId
            )
              return Err({ code: "stale_target", uri: destination.canonical });
            destination = current.value;
          }
          if (
            policy.target === "exact" &&
            policy.authorizeDestination &&
            !(await policy.authorizeDestination(destination.canonical))
          )
            return Err({ code: "destination_missing", uri: destination.canonical });
          if (policy.target === "exact" && policy.expected) {
            const token = await this.inspect(source);
            if (!token.ok) return token;
            const kind = policy.expected.kind === "folder" ? "directory" : "file";
            if (token.value?.kind !== kind || token.value.nodeId !== policy.expected.nodeId) {
              return Err({ code: "stale_source", uri: source.canonical });
            }
          }
          if (source.canonical === destination.canonical) {
            return policy.target === "exact"
              ? this.graduateInPlace(source)
              : Err({ code: "invalid_operation", uri: destination.canonical });
          }
          if (!source.adapter.capabilities.writable || !destination.adapter.capabilities.writable) {
            return Err({ code: "permission_denied", uri: destination.canonical });
          }
          if (!source.adapter.tree || !destination.adapter.tree) {
            return Err({ code: "permission_denied", uri: destination.canonical });
          }

          const prepared = await this.prepareMove(source, destination, policy);
          if (!prepared.ok) return prepared;
          if (
            prepared.value.expectedTarget.state === "occupied" &&
            prepared.value.expectedTarget.token.nodeId === prepared.value.source.nodeId &&
            prepared.value.expectedTarget.token.sourceId === prepared.value.source.sourceId
          ) {
            return prepared.value.source.kind === "file"
              ? this.graduateInPlace({ ...source, path: prepared.value.source.path })
              : Ok({
                  movedNodeId: prepared.value.source.nodeId,
                  destinationPath: prepared.value.source.path,
                });
          }
          const result = await callAdapter(
            destination.canonical,
            () =>
              destination.adapter.tree?.commitPreparedMove({
                ...prepared.value,
                actorUserId: policy.target === "container" ? policy.actorUserId : undefined,
                linkNoteProjectId: this.moveLinks?.linkNoteProjectId,
              }) ?? Promise.resolve(Err({ code: "permission_denied" } as const)),
          );
          if (!result.ok) return result;
          const parsedDestination = parseContextUri(destination.canonical);
          if (!parsedDestination.ok) throw new Error("Invalid resolved destination URI");
          return Ok({
            movedNodeId: result.value.movedNodeId,
            ...(result.value.linkUpdate ? { linkUpdate: result.value.linkUpdate } : {}),
            destinationPath: prepared.value.destinationPath,
            ...(policy.target === "exact" && policy.destinationParent
              ? {
                  destinationUri: formatParsedContextUri(
                    destination.scheme,
                    prepared.value.destinationPath,
                    parsedDestination.value.authority,
                  ),
                }
              : {}),
          });
        },
        destinationResolver
          ? async () => {
              const current = await destinationResolver();
              if (current.ok) lockedDestination = current.value;
              return [source, lockedDestination].map(scopeOf);
            }
          : [source, destination].map(scopeOf),
      )
      .catch((error) => lifecycleCommandFailure(error, source.canonical));
  }

  private async graduateInPlace(
    source: ContextTreeDispatch,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    if (!source.adapter.capabilities.writable || !source.adapter.tree) {
      return Err({ code: "permission_denied", uri: source.canonical });
    }
    const token = await this.inspect(source);
    if (!token.ok) return token;
    if (token.value === null) return Err({ code: "not_found", uri: source.canonical });
    if (token.value.kind !== "file") {
      return Err({ code: "invalid_operation", uri: source.canonical });
    }
    const fileToken = token.value;
    const result = await callAdapter(
      source.canonical,
      () =>
        source.adapter.tree?.commitProvisionalGraduation(fileToken) ??
        Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
    if (!result.ok) return result;
    return Ok({ movedNodeId: fileToken.nodeId, destinationPath: fileToken.path });
  }

  async delete(
    target: ContextTreeDispatch,
    options: ContextDeleteOptions,
  ): Promise<Result<DeleteContextEntryResult, ContextError>> {
    if (options.operationId) {
      if (!this.receipts) return Err({ code: "invalid_operation", uri: target.canonical });
      return this.receipts.execute(
        options.operationId,
        { kind: "delete", uri: target.canonical, expected: options.expected },
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

    const token = await this.inspect(target);
    if (!token.ok) return token;
    if (token.value === null) return Err({ code: "not_found", uri: target.canonical });
    if (
      options.expected.kind === "folder"
        ? token.value.kind !== "directory" || token.value.nodeId !== options.expected.nodeId
        : token.value.kind !== "file" || token.value.nodeId !== options.expected.documentId
    ) {
      return Err({ code: "stale_target", uri: target.canonical });
    }

    const result = await callAdapter(
      target.canonical,
      () =>
        target.adapter.tree?.commitRecursiveDelete({
          root: token.value as ContextLocationToken,
          mode: "recursive",
          actorUserId: options.origin?.type === "human" ? options.origin.userId : undefined,
          removal: options.removal,
        }) ?? Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
    if (!result.ok) {
      return result.error.code === "stale_source"
        ? Err({ code: "stale_target", uri: target.canonical })
        : result;
    }
    return Ok({
      status: "deleted",
      deletedDocumentIds: result.value.deletedDocumentIds,
      availabilityGeneration: result.value.availabilityGeneration,
    });
  }

  private async prepareMove(
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch,
    policy: LocationChangePolicy,
  ): Promise<Result<PreparedContextMove, ContextError>> {
    const sourceToken = await this.inspect(source);
    if (!sourceToken.ok) return sourceToken;
    if (sourceToken.value === null) return Err({ code: "not_found", uri: source.canonical });

    const sourceBasename = basename(sourceToken.value.path);
    if (!sourceBasename) return Err({ code: "invalid_operation", uri: source.canonical });

    const destinationSourceId = await this.destinationSourceId(destination);
    if (!destinationSourceId.ok) return destinationSourceId;

    let destinationParentToken: Extract<ContextLocationToken, { kind: "directory" }> | undefined;
    const createFolders =
      policy.target === "exact" ? (policy.destinationParent?.createFolders ?? []) : [];
    if (!createFolders.every((segment) => validateContextEntryName(segment).ok))
      return Err({ code: "invalid_operation", uri: destination.canonical });
    if (policy.target === "exact" && policy.destinationParent) {
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
    let targetPath = await this.resolveTarget(
      destination,
      sourceBasename,
      policy.target === "exact",
    );
    if (!targetPath.ok) return targetPath;
    let destinationFiletype: Filetype | null | undefined;
    if (sourceToken.value.kind === "file") {
      const targetInput = basename(targetPath.value);
      const targetParts = storedFilename(targetInput, sourceBasename);
      if (!targetParts.ok) return Err({ ...targetParts.error, uri: destination.canonical });
      destinationFiletype =
        sourceToken.value.filetype === null &&
        !targetParts.filename.extension &&
        targetInput.trim() === targetParts.filename.name
          ? null
          : targetParts.filename.filetype;
      targetPath = Ok(joinPath(dirname(targetPath.value), targetParts.name));
    }
    if (!targetPath.ok) return targetPath;

    const existingTarget = await this.inspect({ ...destination, path: targetPath.value });
    if (!existingTarget.ok) return existingTarget;
    if (existingTarget.value) {
      const guard = this.validateExistingTarget(
        sourceToken.value,
        existingTarget.value,
        destination.canonical,
        { overwrite: policy.overwrite },
      );
      if (!guard.ok) return guard;
    }

    if (sourceToken.value.kind === "directory") {
      const targetParentPath = dirname(targetPath.value);
      if (
        sourceToken.value.sourceId === destinationSourceId.value &&
        (targetParentPath === sourceToken.value.path ||
          targetParentPath.startsWith(`${sourceToken.value.path}/`))
      ) {
        return Err({ code: "invalid_operation", uri: destination.canonical });
      }
    }

    const expectedTarget = existingTarget.value
      ? ({ state: "occupied", token: existingTarget.value } as const)
      : ({ state: "absent" } as const);
    const prepared = {
      source: sourceToken.value,
      destinationSourceId: destinationSourceId.value,
      ...(destinationParentToken ? { destinationParentToken } : {}),
      ...(createFolders.length ? { destinationCreateFolders: createFolders } : {}),
      destinationPath: targetPath.value,
      expectedTarget,
      overwrite: policy.overwrite,
    };
    return sourceToken.value.kind === "file"
      ? Ok({
          ...prepared,
          source: sourceToken.value,
          destinationFiletype,
          graduateProvisionalName:
            policy.target === "exact" && policy.graduateProvisionalName === true,
        })
      : Ok({ ...prepared, source: sourceToken.value });
  }

  private async inspect(
    dispatch: ContextTreeDispatch,
  ): Promise<Result<ContextLocationToken | null, ContextError>> {
    const tree = dispatch.adapter.tree;
    if (!tree) return Err({ code: "permission_denied", uri: dispatch.canonical });
    return callAdapter(dispatch.canonical, () => tree.inspectMovable(dispatch.path));
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

  private async resolveTarget(
    destination: ContextTreeDispatch,
    sourceBasename: string,
    exactTarget = false,
  ): Promise<Result<string, ContextError>> {
    if (exactTarget) {
      const targetPath = destination.path.split("/").filter(Boolean).join("/");
      if (!basename(targetPath)) {
        return Err({ code: "invalid_operation", uri: destination.canonical });
      }
      return Ok(targetPath);
    }
    const destinationEntry = await this.inspect(destination);
    if (!destinationEntry.ok) return destinationEntry;
    const targetPath =
      destinationEntry.value?.kind === "directory"
        ? joinPath(destination.path, sourceBasename)
        : destination.path.split("/").filter(Boolean).join("/");
    if (!basename(targetPath)) {
      return Err({ code: "invalid_operation", uri: destination.canonical });
    }
    return Ok(targetPath);
  }

  private validateExistingTarget(
    source: ContextLocationToken,
    existingTarget: ContextLocationToken,
    destinationUri: string,
    options?: ContextMoveOptions,
  ): Result<void, ContextError> {
    if (source.nodeId === existingTarget.nodeId && source.sourceId === existingTarget.sourceId)
      return Ok(undefined);
    if (source.kind !== existingTarget.kind) {
      return Err({ code: "conflict", uri: destinationUri });
    }
    if (!options?.overwrite || source.kind === "directory") {
      return Err({ code: "conflict", uri: destinationUri });
    }
    return Ok(undefined);
  }
}
