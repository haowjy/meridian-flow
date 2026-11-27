import type { CommandId } from "@meridian/contracts";
import type { ProjectDto } from "@meridian/contracts/projects";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";
import { projectDto } from "../../../../lib/project-dto.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo } = app;
  const { userId } = user;
  const { commandId, body } = splitCommandBody(await readBody(event));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    throw createError({ statusCode: 400, message: "title is required" });
  }

  const project = await requireProjectOwner(
    { projects: projectRepo },
    getRouterParam(event, "projectId") ?? "",
    userId,
    { includeSoftDeleted: true },
  );
  const result = await runRouteCommand<{ status: "done"; project: ProjectDto }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId,
      projectId: project.id,
      kind: "project_rename",
      body: { title },
    },
    async () => ({
      status: "done",
      project: projectDto(await projectRepo.rename(project.id, title)),
    }),
    () => undefined,
  );
  return serializeTransport(result.project);
});
