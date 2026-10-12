/** Prepare an owned project export and return its counted, frozen download handoff. */
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { ExportReadError } from "../../../../domains/export/domain/project-export.js";
import { requireProjectOwner } from "../../../../domains/projects/project-access.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const project = await requireProjectOwner(
    { projects: app.projectRepo },
    requireRequestId(getRouterParam(event, "projectId"), "projectId"),
    user.userId,
  );
  const raw = (await readBody<unknown>(event)) ?? {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw createError({ statusCode: 400, message: "Export options must be an object" });
  const body = raw as Record<string, unknown>;
  if (
    (body.scratch !== undefined && typeof body.scratch !== "boolean") ||
    (body.uploads !== undefined && typeof body.uploads !== "boolean")
  )
    throw createError({ statusCode: 400, message: "scratch and uploads must be booleans" });
  try {
    return await app.projectExport.start(project.id, user.userId, project.name, {
      scratch: body.scratch === true,
      uploads: body.uploads === true,
    });
  } catch (error) {
    if (!(error instanceof ExportReadError)) throw error;
    throw createError({ statusCode: 503, message: error.message, data: { retryable: true } });
  }
});
