/**
 * The delete behind POST /api/projects/:projectId/context/entries/:entryId/delete: one file or
 * folder (with everything under it), found by its id. Access follows the move's: the project is
 * the user's, a recorded outcome answers a resend first, the project holds the row, and the
 * writer may edit the document, or the area a folder is in (there is no folder target).
 */
import type { DeleteContextEntryResult } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import {
  contextPortForProjectAuthorities,
  deleteCommand,
  type ProjectContextAvailabilityPort,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import type { FileAccess } from "../domains/file-policy/index.js";
import {
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
} from "../domains/projects/index.js";
import { locateEntry, replayedResult } from "./context-entry-route.js";
import { contextErrorToHttp, throwContextWorkUnavailableHttpError } from "./context-error-http.js";
import { containerOf, locatorUri } from "./context-locator.js";
import { documentTarget, requireFileGrant, withEditGrants } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";

export interface ContextDeleteRouteDeps {
  fileAccess: Pick<FileAccess, "authorize" | "confirmEdit">;
  projectRepo: ProjectRepository;
  contextPorts: UnifiedContextPortFactory;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
  availability: ProjectContextAvailabilityPort;
}

function parseContextDelete(body: unknown): {
  operationId: string;
  kind: "file" | "folder";
} {
  if (!body || typeof body !== "object")
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  const fields = body as { operationId?: unknown; kind?: unknown };
  const { kind } = fields;
  if (kind !== "file" && kind !== "folder")
    throw createError({ statusCode: 400, message: "Entry kind is required" });
  return { operationId: requireRequestId(fields.operationId, "operationId"), kind };
}

export async function handleContextDeleteRequest(
  deps: ContextDeleteRouteDeps,
  input: { projectId: string; userId: string; entryId: string; body: unknown },
): Promise<DeleteContextEntryResult> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const { operationId, kind } = parseContextDelete(input.body);
  const requested = { kind, nodeId: input.entryId };
  const command = deleteCommand({ expected: requested });
  const replay = await replayedResult(deps, input, operationId, command);
  if (replay) {
    if (!replay.ok) contextErrorToHttp(replay.error);
    return replay.value;
  }
  const { address, locator } = await locateEntry(deps, { ...input, kind });
  if (locator.scope === "chat")
    throw createError({ statusCode: 400, message: "Uploads are removed from their chat" });
  const workIds =
    locator.scope === "work" ? new Set([locator.authority.workId]) : new Set<string>();
  const port = await contextPortForProjectAuthorities({
    deps: { contextPorts: deps.contextPorts, workAuthorityResolver: deps.workAuthorityResolver },
    projectId: input.projectId,
    userId: input.userId,
    workIds,
    primaryWorkId: [...workIds][0],
  });
  if (!port) return throwContextWorkUnavailableHttpError("work_missing");
  const target =
    kind === "file" ? documentTarget(address.id) : containerOf(locator, input.projectId);
  const grant = await requireFileGrant(deps.fileAccess, input.userId, target, "edit");
  const result = await withEditGrants(deps.fileAccess, [grant], () =>
    port.delete({ kind, nodeId: address.id }, locatorUri(locator, ""), {
      origin: { type: "human", userId: input.userId },
      operation: { id: operationId, command },
    }),
  );
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value;
}
