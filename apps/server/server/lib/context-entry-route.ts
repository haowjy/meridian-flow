/**
 * What the by-id entry routes (move, delete) share: answering a resend from its recorded
 * outcome before touching the row, finding the row, and running the command under the writer's
 * edit grants. A route supplies only what differs: its command, its refusal for uploads, and
 * the plan for a located entry.
 */
import { isDeepStrictEqual } from "node:util";
import type { ContextOperationCommand, ContextOperationResult } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import {
  type ContextPort,
  contextPortForProjectAuthorities,
  contextPortForProjectBrowse,
  type HeldContextNodeAddress,
  type ProjectContextAvailabilityPort,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import type { FileAccess, FileTarget } from "../domains/file-policy/index.js";
import type { ProjectWorkAuthorityResolver } from "../domains/projects/index.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import {
  type ChatLocator,
  locateNode,
  type ResolvedContextLocator,
  throwLocatorRefusal,
} from "./context-locator.js";
import { requireFileGrant, withEditGrants } from "./file-access-http.js";

export type EntryRouteDeps = {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  availability: ProjectContextAvailabilityPort;
};

type OkValue<K extends ContextOperationCommand["kind"]> = Extract<
  ContextOperationResult<K>,
  { ok: true }
>["value"];

/**
 * A by-id move or delete, from resend to answer. The caller has checked the project and parsed
 * the body. A resend answers from its receipt, then the entry is located (uploads refused with
 * `uploads`), `plan` says what else the command reaches and which grants it needs, and the
 * commit runs under them. Returns the receipt's value; a refusal throws its HTTP answer.
 */
export async function runEntryCommand<K extends ContextOperationCommand["kind"]>(
  deps: EntryRouteDeps,
  input: { projectId: string; userId: string; entryId: string },
  entry: {
    kind: "file" | "folder";
    operationId: string;
    command: Extract<ContextOperationCommand, { kind: K }>;
    uploads: string;
    plan(located: { address: HeldContextNodeAddress; source: ResolvedContextLocator }): Promise<{
      /** Another area the command reaches, whose Work the port must hold. */
      destination?: ResolvedContextLocator;
      grants: FileTarget[];
      commit(port: ContextPort): Promise<ContextOperationResult<K>>;
    }>;
  },
): Promise<OkValue<K>> {
  const replay = await replayedResult(deps, input, entry.operationId, entry.command);
  if (replay) {
    if (!replay.ok) contextErrorToHttp(replay.error);
    return replay.value as OkValue<K>;
  }
  const { address, locator: source } = await locateEntry(deps, { ...input, kind: entry.kind });
  if (source.scope === "chat") throw createError({ statusCode: 400, message: entry.uploads });
  const plan = await entry.plan({ address, source });
  const workIds = new Set(
    [source, plan.destination].flatMap((locator) =>
      locator?.scope === "work" ? [locator.authority.workId] : [],
    ),
  );
  const port = await contextPortForProjectAuthorities({
    deps,
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId: source.scope === "work" ? source.authority.workId : [...workIds][0],
  });
  if (!port) return throwContextWorkUnavailableHttpError("work_missing");
  const grants = [];
  for (const target of plan.grants)
    grants.push(await requireFileGrant(deps.fileAccess, input.userId, target, "edit"));
  const result = await withEditGrants(deps.fileAccess, grants, () => plan.commit(port));
  if (!result.ok) return contextErrorToHttp(result.error);
  return result.value as OkValue<K>;
}

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
async function replayedResult<K extends ContextOperationCommand["kind"]>(
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
