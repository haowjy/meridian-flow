/** Current-state preview; it neither prepares nor authorizes a later download. */
import { createError, defineEventHandler, getQuery, getRouterParam, setHeader } from "nitro/h3";
import { ExportReadError } from "../../../../../domains/export/domain/project-export.js";
import { requireProjectOwner } from "../../../../../domains/projects/project-access.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { exportOptions } from "../../../../../lib/export-options.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const project = await requireProjectOwner(
    { projects: app.projectRepo },
    requireRequestId(getRouterParam(event, "projectId"), "projectId"),
    user.userId,
  );
  setHeader(event, "Cache-Control", "private, no-store");
  try {
    return await app.projectExport.preview(project.id, user.userId, exportOptions(getQuery(event)));
  } catch (error) {
    if (!(error instanceof ExportReadError)) throw error;
    throw createError({ statusCode: 503, message: error.message, data: { retryable: true } });
  }
});
