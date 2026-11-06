/**
 * The delete behind POST /api/projects/:projectId/context/entries/:entryId/delete: one file or
 * folder (with everything under it), found by its id. Access follows the move's: the project is
 * the user's, a recorded outcome answers a resend first, the project holds the row, and the
 * writer may edit the document, or the area a folder is in (there is no folder target).
 */
import type { DeleteContextEntryResult } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import { deleteCommand } from "../domains/context/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import { type EntryRouteDeps, runEntryCommand } from "./context-entry-route.js";
import { containerOf, locatorUri } from "./context-locator.js";
import { documentTarget } from "./file-access-http.js";
import { requireRequestId } from "./request-id.js";

export type ContextDeleteRouteDeps = EntryRouteDeps & { projectRepo: ProjectRepository };

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
  const command = deleteCommand({ expected: { kind, nodeId: input.entryId } });
  return runEntryCommand(deps, input, {
    kind,
    operationId,
    command,
    uploads: "Uploads are removed from their chat",
    plan: async ({ address, source }) => ({
      grants: [kind === "file" ? documentTarget(address.id) : containerOf(source, input.projectId)],
      commit: (port) =>
        port.delete({ kind, nodeId: address.id }, locatorUri(source, ""), {
          origin: { type: "human", userId: input.userId },
          operation: { id: operationId, command },
        }),
    }),
  });
}
