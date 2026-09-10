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
  return { projectId: projectId as ProjectId, documentIds: documentIds as DocumentId[] };
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
