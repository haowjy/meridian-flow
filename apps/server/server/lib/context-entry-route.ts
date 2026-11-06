/**
 * What the by-id entry routes (move, delete) share: finding the row, and answering a resend
 * from its recorded outcome before touching the row.
 */
import { isDeepStrictEqual } from "node:util";
import type { ContextOperationCommand, ContextOperationResult } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import {
  contextPortForProjectBrowse,
  type HeldContextNodeAddress,
  type ProjectContextAvailabilityPort,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import type { ProjectWorkAuthorityResolver } from "../domains/projects/index.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import {
  type ChatLocator,
  locateNode,
  type ResolvedContextLocator,
  throwLocatorRefusal,
} from "./context-locator.js";

type EntryRouteDeps = {
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  availability: ProjectContextAvailabilityPort;
};

/**
 * Where this project holds the entry the URL names (`locateNode`), as a route answers it: an
 * entry no live address names is a 404 (`missing` says which end of a move was asked about),
 * and uploads, which belong to their chat, are refused.
 */
export async function locateEntry(
  deps: EntryRouteDeps,
  input: {
    projectId: string;
    userId: string;
    entryId: string;
    kind: "file" | "folder";
    missing?: "not_found" | "destination_missing";
  },
): Promise<{
  address: HeldContextNodeAddress;
  locator: ResolvedContextLocator | ChatLocator;
}> {
  const located = await locateNode(deps, {
    projectId: input.projectId,
    userId: input.userId,
    node:
      input.kind === "file"
        ? { kind: "document", id: input.entryId as DocumentId }
        : { kind: "folder", id: input.entryId },
  });
  if (!located.ok) {
    if (located.error.reason === "not_found")
      return contextErrorToHttp({ code: input.missing ?? "not_found", uri: input.entryId });
    return throwLocatorRefusal(located.error);
  }
  return located.value;
}

/**
 * The recorded outcome of this operation when it was sent before with this same command. A
 * committed operation's resend must answer before the row is located, since the row may no
 * longer be where it was. A different command under the same id falls through: the mover answers
 * `operation_mismatch` with an address.
 */
export async function replayedResult<K extends ContextOperationCommand["kind"]>(
  deps: EntryRouteDeps,
  input: { projectId: string; userId: string },
  operationId: string,
  command: Extract<ContextOperationCommand, { kind: K }>,
): Promise<ContextOperationResult<K> | null> {
  const port = await contextPortForProjectBrowse({
    deps,
    projectId: input.projectId,
    userId: input.userId,
    workId: null,
  });
  if (!port) return throwContextWorkUnavailableHttpError("work_missing");
  const receipt = await port.lookupOperation(operationId);
  return receipt && isDeepStrictEqual(receipt.command, command)
    ? (receipt.result as ContextOperationResult<K>)
    : null;
}
