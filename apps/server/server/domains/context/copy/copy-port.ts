import type { CopySourceView } from "../ports/context-port.js";
/**
 * The port's Copy: turn a request of canonical addresses into the adapters that own them and
 * hand the command its sources, destination and (for an identity destination) a way to
 * resolve it again under the locks. The router supplies address resolution; everything that
 * reads or writes is `copy-command.ts`.
 */

import { isDraftedScheme, isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { CopyContextEntriesResult } from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { ContextSchemeAdapter } from "../ports/context-adapter.js";
import type { ContextCommandTransaction } from "../ports/context-command-transaction.js";
import type { ContextCopyRequest, ContextError, ContextScheme } from "../ports/context-port.js";
import {
  type ContextCopyCommandDeps,
  type CopyDestinationHandoff,
  type CopySourceHandoff,
  createContextCopyCommand,
  receiptCommand,
} from "./copy-command.js";
import type { CopyCommands } from "./copy-commands.js";

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
  commands: CopyCommands | undefined;
  commandTransaction: ContextCommandTransaction | undefined;
  /** The router's one identity-destination resolver, re-run under the command's locks. */
  resolveIdentityDestination: (
    parent: { folderId: string; createFolders?: readonly string[] },
    options: {
      authorize?: (uri: string) => Promise<boolean>;
      view?: CopySourceView;
    },
  ) => Promise<Result<CopyEnd, ContextError>>;
  resolve(uri: string): Promise<Result<CopyEnd, ContextError>>;
}

export function createContextCopyPort(deps: ContextCopyPortDeps) {
  /** A destination this scheme can copy into, or null when it has no copy capability. */
  const handoff = (
    end: CopyEnd,
    folder: { folderId: string; createFolders?: readonly string[] } | null,
    draft?: ContextCopyRequest["destinationDraft"],
  ): CopyDestinationHandoff | null => {
    const copy = end.adapter.copy;
    return copy
      ? {
          uri: end.canonical,
          copy,
          scheme: end.adapter.name as ContextScheme,
          dir: end.path.split("/").filter(Boolean),
          // A port's primary Work is not the owner of a project scheme's namespace.
          workScopeId: isWorkScopedScheme(end.adapter.name as ContextScheme)
            ? end.workScopeId
            : null,
          draft: isDraftedScheme(end.adapter.name as ContextScheme) ? (draft ?? null) : null,
          ...(folder
            ? { parent: { folderId: folder.folderId, createFolders: folder.createFolders ?? [] } }
            : {}),
        }
      : null;
  };

  /**
   * A Copy into a folder the project no longer holds: nothing is copied. The answer is stored
   * under the operation ID like every other, so a resend reads the same one.
   */
  async function leftOutForMissingFolder(
    request: ContextCopyRequest,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    if (!deps.commands) {
      return Err({
        code: "invalid_operation",
        uri: request.destinationUri,
        message: "Copy is not available here",
      });
    }
    const command = receiptCommand(
      request.sources.map((source) => ({ ...source, view: source.view ?? { kind: "live" } })),
      request.destinationUri,
      request,
    );
    return deps.commands.execute(request.operationId, command, request.destinationUri, async () =>
      Ok({
        status: "copied",
        entries: [],
        folders: [],
        settled: [
          { rule: "left_out", items: request.sources.map((source) => source.uri), why: "purged" },
        ],
      }),
    );
  }

  async function copy(
    request: ContextCopyRequest,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    const { commands, commandTransaction } = deps;
    if (!deps.copy || !commands || !commandTransaction) {
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
      const { adapter, canonical, path } = resolved.value;
      const copy = adapter.copy;
      if (!copy) {
        return Err({
          code: "invalid_operation",
          uri: canonical,
          message: "This source cannot be copied",
        });
      }
      sources.push({
        uri: canonical,
        copy,
        path,
        view: source.view ?? { kind: "live" },
        expected: source.expected,
        ...(source.copyId ? { copyId: source.copyId } : {}),
        ...(source.roomVersion ? { roomVersion: source.roomVersion } : {}),
      });
    }

    const destination = await deps.resolve(request.destinationUri);
    if (!destination.ok) return destination;
    const parent = request.destinationParent;
    const folderParent = parent?.kind === "folder" ? parent : null;
    const destinationHandoff = handoff(destination.value, folderParent, request.destinationDraft);
    if (!destinationHandoff) {
      return Err({
        code: "invalid_operation",
        uri: destination.value.canonical,
        message: "This destination cannot take a copy",
      });
    }

    return createContextCopyCommand(deps.copy).copy({
      environment: { commands, commandTransaction },
      request,
      sources,
      destination: destinationHandoff,
      ...(folderParent
        ? {
            resolveDestination: async (): Promise<Result<CopyDestinationHandoff, ContextError>> => {
              const target = await deps.resolveIdentityDestination(folderParent, {
                ...(destinationHandoff.draft
                  ? { view: { kind: "draft" as const, draft: destinationHandoff.draft.draftId } }
                  : {}),
                ...(request.authorizeDestination
                  ? { authorize: request.authorizeDestination }
                  : {}),
              });
              if (!target.ok) return target;
              const current = handoff(target.value, folderParent, request.destinationDraft);
              return current
                ? Ok(current)
                : Err({
                    code: "invalid_operation",
                    uri: target.value.canonical,
                    message: "This destination cannot take a copy",
                  });
            },
          }
        : {}),
    });
  }

  return { copy, leftOutForMissingFolder };
}
