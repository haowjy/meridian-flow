/** POST /api/projects: creates a project for the authenticated user. Depends on the auth gate and project repository. */
import type { CommandId } from "@meridian/contracts";
import type { ProjectDto } from "@meridian/contracts/projects";
import { type CreateProjectRequest, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";

import { requireAppUser } from "../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../lib/command-route.js";
import { projectDto } from "../../../lib/project-dto.js";
import { parseOptionalRequestId } from "../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo } = app;
  const { userId } = user;
  const { commandId, body } = splitCommandBody(await readBody(event)) as {
    commandId: CommandId;
    body: Partial<CreateProjectRequest>;
  };
  if (!body.title?.trim()) {
    throw createError({ statusCode: 400, message: "title is required" });
  }
  const id = parseOptionalRequestId(body.id, "id") ?? crypto.randomUUID();

  const { project } = await runRouteCommand<{ status: "done"; project: ProjectDto }>(
    app.commands,
    { commandId, userId, projectId: id, kind: "project_create", body },
    async () => ({
      status: "done",
      project: projectDto(
        await projectRepo.create({
          id,
          userId,
          title: body.title?.trim(),
          description: body.description ?? null,
        }),
      ),
    }),
    () => undefined,
  );

  event.res.status = 201;
  return serializeTransport(project);
});
