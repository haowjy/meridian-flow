/** Owner-gated, stable-ID-only project context availability lookup. */
import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { ProjectContextIdentityLookupRequest } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
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
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId, {
    includeSoftDeleted: true,
  });
  return app.projectContextAvailability.lookup(
    parseAvailabilityBody(projectId, await readBody(event)),
    { userId: user.userId },
  );
});
