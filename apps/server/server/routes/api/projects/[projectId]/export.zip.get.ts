/** Authorize the current inventory and stream a ZIP without a prepared handoff. */
import type { Readable } from "node:stream";
import { createError, defineEventHandler, getQuery, getRouterParam, setHeader } from "nitro/h3";
import { ExportReadError } from "../../../../domains/export/domain/project-export.js";
import { requireProjectOwner } from "../../../../domains/projects/project-access.js";
import { attachmentDisposition } from "../../../../lib/attachment-disposition.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { exportOptions } from "../../../../lib/export-options.js";
import { requireRequestId } from "../../../../lib/request-id.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const project = await requireProjectOwner(
    { projects: app.projectRepo },
    requireRequestId(getRouterParam(event, "projectId"), "projectId"),
    user.userId,
  );
  let stream: Readable;
  try {
    stream = await app.projectExport.download(
      project.id,
      user.userId,
      project.name,
      exportOptions(getQuery(event)),
    );
  } catch (error) {
    if (error instanceof ExportReadError && error.code === "too_large")
      throw createError({ statusCode: 413, message: error.message });
    throw error;
  }
  setHeader(event, "Content-Type", "application/zip");
  setHeader(event, "Content-Disposition", attachmentDisposition(`${project.name}.zip`));
  setHeader(event, "Cache-Control", "private, no-store");
  return stream;
});
