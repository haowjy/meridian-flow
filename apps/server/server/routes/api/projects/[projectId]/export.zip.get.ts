/** Authorize the current inventory and stream a ZIP without a prepared handoff. */
import { defineEventHandler, getQuery, getRouterParam, setHeader } from "nitro/h3";
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
  const stream = await app.projectExport.download(
    project.id,
    user.userId,
    project.name,
    exportOptions(getQuery(event)),
  );
  setHeader(event, "Content-Type", "application/zip");
  setHeader(event, "Content-Disposition", attachmentDisposition(`${project.name}.zip`));
  setHeader(event, "Cache-Control", "private, no-store");
  return stream;
});
