/** POST /api/projects: creates a project for the authenticated user. Depends on the auth gate and project repository. */
import { type CreateProjectRequest, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";

import { requireAppUser } from "../../../lib/auth-gate.js";
import { parseOptionalRequestId } from "../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo } = app;
  const { userId } = user;
  const body = (await readBody<CreateProjectRequest>(event)) ?? { title: "" };
  if (!body.title?.trim()) {
    throw createError({ statusCode: 400, message: "title is required" });
  }

  const project = await projectRepo.create({
    id: parseOptionalRequestId(body.id, "id"),
    userId,
    title: body.title.trim(),
    description: body.description ?? null,
  });

  await app.seedDefaultPackagesForProject(project.id);

  event.res.status = 201;
  return serializeTransport(project);
});
