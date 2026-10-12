/** Consume a prepared, owner-bound download ticket and stream its frozen ZIP. */
import { createError, defineEventHandler, getQuery, getRouterParam, setHeader } from "nitro/h3";
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
  const token = getQuery(event).export;
  if (typeof token !== "string")
    throw createError({ statusCode: 400, message: "Prepare an export before downloading it" });
  const ticket = app.projectExport.download(token, project.id, user.userId);
  if (!ticket)
    throw createError({ statusCode: 404, message: "This export expired. Prepare a new export." });
  setHeader(event, "Content-Type", "application/zip");
  setHeader(event, "Content-Disposition", attachmentDisposition(ticket.fileName));
  return ticket.stream();
});
