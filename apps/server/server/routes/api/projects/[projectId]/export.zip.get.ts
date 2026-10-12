/** Owner-gated project ZIP with optional Work Scratch and Uploads. */
import { defineEventHandler, getQuery, getRouterParam, setHeader } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/project-access.js";
import { attachmentDisposition } from "../../../../lib/attachment-disposition.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const project = await requireProjectOwner(
    { projects: app.projectRepo },
    requireRequestId(getRouterParam(event, "projectId"), "projectId"),
    user.userId,
  );
  const query = getQuery(event);
  const snapshot = await app.projectExport.prepare(project.id, user.userId, {
    scratch: query.scratch === "1",
    uploads: query.uploads === "1",
  });
  setHeader(event, "Content-Type", "application/zip");
  setHeader(event, "Content-Disposition", attachmentDisposition(`${project.name}.zip`));
  return snapshot.stream(project.name);
});
