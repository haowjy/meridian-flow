/** Owner-gated, stable-ID-only project context availability lookup. */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { ProjectContextIdentityLookupRequest } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export function parseAvailabilityBody(
  projectId: string,
  raw: unknown,
): ProjectContextIdentityLookupRequest {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { documentIds?: unknown }).documentIds)
  ) {
    throw createError({ statusCode: 400, message: "documentIds must be an array" });
  }
  const documentIds = [
    ...new Set(
      (raw as { documentIds: unknown[] }).documentIds.map((id) =>
        requireRequestId(id, "documentIds[]"),
      ),
    ),
  ];
  if (documentIds.length > 128) {
    throw createError({ statusCode: 400, message: "documentIds must contain at most 128 IDs" });
  }
  const rawFolders = (raw as { folderIds?: unknown }).folderIds;
  if (rawFolders !== undefined && !Array.isArray(rawFolders))
    throw createError({ statusCode: 400, message: "folderIds must be an array" });
  const folderIds = [
    ...new Set((rawFolders ?? []).map((id: unknown) => requireRequestId(id, "folderIds[]"))),
  ];
  if (folderIds.length + documentIds.length > 128)
    throw createError({
      statusCode: 400,
      message: "availability lookup must contain at most 128 IDs",
    });
  return {
    projectId: projectId as ProjectId,
    documentIds: documentIds as DocumentId[],
    ...(rawFolders !== undefined ? { folderIds } : {}),
  };
}

export default defineEventHandler(async (event) => {
  const startedAt = performance.now();
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId, {
    includeSoftDeleted: true,
  });
  const authorizedAt = performance.now();
  const result = await app.projectContextAvailability.lookup(
    parseAvailabilityBody(projectId, await readBody(event)),
    { userId: user.userId },
  );
  const endedAt = performance.now();
  setHeader(
    event,
    "Server-Timing",
    `auth;dur=${(authorizedAt - startedAt).toFixed(1)}, lookup;dur=${(endedAt - authorizedAt).toFixed(1)}, total;dur=${(endedAt - startedAt).toFixed(1)}`,
  );
  return result;
});
