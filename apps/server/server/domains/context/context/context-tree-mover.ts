/**
 * ContextTreeMover owns filesystem move/delete semantics after URI routing.
 * It prepares ContextLocationToken CAS plans (same-path guard, Unix basename
 * target resolution, overwrite/type rules, and folder-into-self rejection) and
 * delegates the single durable commit to a ContextTreeMutationStore-backed
 * adapter capability.
 */

import { Err, Ok, type Result } from "../../../shared/result.js";
import type { AdapterFault, ContextSchemeAdapter } from "../ports/context-adapter.js";
import type {
  ContextError,
  ContextMoveOptions,
  ContextMoveResult,
  ContextScheme,
  ContextWriteOptions,
} from "../ports/context-port.js";
import type {
  ContextLocationToken,
  PreparedContextMove,
} from "../ports/context-tree-mutation-store.js";

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
  if (!result.ok) {
    switch (result.error.code) {
      case "permission_denied":
        return Err({ code: "permission_denied", uri });
      case "conflict":
        return Err({ code: "conflict", uri });
      case "invalid_operation":
        return Err({ code: "invalid_operation", uri });
      case "context_unavailable":
        return Err({ code: "context_unavailable", uri });
      case "io_error":
        return Err({ code: "io_error", uri, message: result.error.message });
    }
  }
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

/** Coordinates ContextFS tree mutations without owning durable state. */
export class ContextTreeMover {
  async move(
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch,
    options?: ContextMoveOptions,
  ): Promise<Result<ContextMoveResult, ContextError>> {
    if (source.canonical === destination.canonical) {
      return Err({ code: "invalid_operation", uri: destination.canonical });
    }
    if (!source.adapter.capabilities.writable || !destination.adapter.capabilities.writable) {
      return Err({ code: "permission_denied", uri: destination.canonical });
    }
    if (!source.adapter.tree || !destination.adapter.tree) {
      return Err({ code: "permission_denied", uri: destination.canonical });
    }

    const prepared = await this.prepareMove(source, destination, options);
    if (!prepared.ok) return prepared;

    const result = await callAdapter(
      destination.canonical,
      () =>
        destination.adapter.tree?.commitPreparedMove(prepared.value) ??
        Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
    if (!result.ok) return result;
    return Ok({ movedNodeId: result.value.movedNodeId });
  }

  async delete(
    target: ContextTreeDispatch,
    _options?: ContextWriteOptions,
  ): Promise<Result<void, ContextError>> {
    if (!target.adapter.capabilities.writable || !target.adapter.tree) {
      return Err({ code: "permission_denied", uri: target.canonical });
    }

    const token = await this.inspect(target);
    if (!token.ok) return token;
    if (token.value === null) return Err({ code: "not_found", uri: target.canonical });

    const result = await callAdapter(
      target.canonical,
      () =>
        target.adapter.tree?.commitPreparedDelete(token.value as ContextLocationToken) ??
        Promise.resolve(Err({ code: "permission_denied" } as const)),
    );
    if (!result.ok) return result;
    return Ok(undefined);
  }

  private async prepareMove(
    source: ContextTreeDispatch,
    destination: ContextTreeDispatch,
    options?: ContextMoveOptions,
  ): Promise<Result<PreparedContextMove, ContextError>> {
    const sourceToken = await this.inspect(source);
    if (!sourceToken.ok) return sourceToken;
    if (sourceToken.value === null) return Err({ code: "not_found", uri: source.canonical });

    const sourceBasename = basename(sourceToken.value.path);
    if (!sourceBasename) return Err({ code: "invalid_operation", uri: source.canonical });

    const destinationSourceId = await this.destinationSourceId(destination);
    if (!destinationSourceId.ok) return destinationSourceId;

    const targetPath = await this.resolveTarget(destination, sourceBasename);
    if (!targetPath.ok) return targetPath;

    const existingTarget = await this.inspect({ ...destination, path: targetPath.value });
    if (!existingTarget.ok) return existingTarget;
    if (existingTarget.value) {
      const guard = this.validateExistingTarget(
        sourceToken.value,
        existingTarget.value,
        destination.canonical,
        options,
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

    return Ok({
      source: sourceToken.value,
      destinationSourceId: destinationSourceId.value,
      destinationPath: targetPath.value,
      expectedTarget: existingTarget.value
        ? { state: "occupied", token: existingTarget.value }
        : { state: "absent" },
      overwrite: options?.overwrite === true,
    });
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
  ): Promise<Result<string, ContextError>> {
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
    if (source.kind !== existingTarget.kind) {
      return Err({ code: "invalid_operation", uri: destinationUri });
    }
    if (!options?.overwrite || source.kind === "directory") {
      return Err({ code: "conflict", uri: destinationUri });
    }
    return Ok(undefined);
  }
}
