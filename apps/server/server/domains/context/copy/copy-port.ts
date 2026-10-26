/**
 * The port's Copy: turn a request of canonical addresses into the adapters that own them and
 * hand the command its sources, destination and (for an identity destination) a way to
 * resolve it again under the locks. The router supplies address resolution; everything that
 * reads or writes is `copy-command.ts`.
 */

import type { CopyContextEntriesResult } from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { ContextOperationReceipts } from "../context/context-operation-receipts.js";
import type { ContextSchemeAdapter } from "../ports/context-adapter.js";
import type { ContextCommandTransaction } from "../ports/context-command-transaction.js";
import type { ContextCopyRequest, ContextError } from "../ports/context-port.js";
import {
  type ContextCopyCommandDeps,
  type CopyDestinationHandoff,
  type CopySourceHandoff,
  createContextCopyCommand,
} from "./copy-command.js";

/** A canonical address resolved to the adapter that owns it. */
export interface CopyEnd {
  adapter: ContextSchemeAdapter;
  canonical: string;
  /** Scheme-relative path. */
  path: string;
  workScopeId: string | null;
}

export interface ContextCopyPortDeps {
  /** Absent compositions refuse Copy typed. */
  copy: ContextCopyCommandDeps | undefined;
  receipts: ContextOperationReceipts | undefined;
  commandTransaction: ContextCommandTransaction | undefined;
  /** A folder identity's address now, or null once it is gone. */
  resolveDestinationFolder: ((folderId: string) => Promise<string | null>) | undefined;
  resolve(uri: string): Promise<Result<CopyEnd, ContextError>>;
}

export function createContextCopyPort(deps: ContextCopyPortDeps) {
  const handoff = (end: CopyEnd): CopyDestinationHandoff => ({
    uri: end.canonical,
    adapter: end.adapter,
    dir: end.path.split("/").filter(Boolean),
    workScopeId: end.workScopeId,
  });

  return async function copy(
    request: ContextCopyRequest,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    const { receipts, commandTransaction } = deps;
    if (!deps.copy || !receipts || !commandTransaction) {
      return Err({
        code: "invalid_operation",
        uri: request.destinationUri,
        message: "Copy is not available here",
      });
    }
    const sources: CopySourceHandoff[] = [];
    for (const source of request.sources) {
      const resolved = await deps.resolve(source.uri);
      if (!resolved.ok) return resolved;
      const { adapter, workScopeId, canonical, path } = resolved.value;
      if (!adapter.copy) {
        return Err({
          code: "invalid_operation",
          uri: canonical,
          message: "This source cannot be copied",
        });
      }
      sources.push({
        uri: canonical,
        adapter,
        path,
        workScopeId,
        view: source.view ?? { kind: "live" },
        expected: source.expected,
        ...(source.stateVector ? { stateVector: source.stateVector } : {}),
      });
    }

    const destination = await deps.resolve(request.destinationUri);
    if (!destination.ok) return destination;
    if (!destination.value.adapter.copy) {
      return Err({
        code: "invalid_operation",
        uri: destination.value.canonical,
        message: "This destination cannot take a copy",
      });
    }

    const parent = request.destinationParent;
    const folderParent = parent?.kind === "folder" ? parent : null;
    return createContextCopyCommand(deps.copy).copy({
      environment: { receipts, commandTransaction },
      request,
      sources,
      destination: handoff(destination.value),
      ...(folderParent
        ? {
            resolveDestination: async (): Promise<Result<CopyDestinationHandoff, ContextError>> => {
              const gone = Err({
                code: "destination_missing",
                uri: request.destinationUri,
              } as const);
              const fresh = await deps.resolveDestinationFolder?.(folderParent.folderId);
              if (!fresh) return gone;
              const suffix = folderParent.createFolders ?? [];
              const target = await deps.resolve(
                suffix.length === 0 ? fresh : [fresh.replace(/\/$/, ""), ...suffix].join("/"),
              );
              if (!target.ok) return gone;
              if (
                request.authorizeDestination &&
                !(await request.authorizeDestination(target.value.canonical))
              ) {
                return Err({ code: "permission_denied", uri: target.value.canonical });
              }
              return Ok(handoff(target.value));
            },
          }
        : {}),
    });
  };
}
