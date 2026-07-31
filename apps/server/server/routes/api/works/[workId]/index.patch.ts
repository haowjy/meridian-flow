/** Updates mutable Work metadata; archive state remains an explicit lifecycle action. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { UpdateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireWorkOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const body = (await readBody<UpdateWorkRequest>(event)) ?? {};
  if (body.name !== undefined && !body.name.trim()) {
    throw createError({ statusCode: 400, message: "name cannot be empty" });
  }
  if (body.status !== undefined && body.status !== "active" && body.status !== "archived") {
    throw createError({ statusCode: 400, message: "status must be active or archived" });
  }

  await requireWorkOwner({ works: app.workRepo, projects: app.projectRepo }, workId, user.userId);
  let work = await app.workRepo.update(workId, {
    name: body.name?.trim(),
    goal: body.goal,
    description: body.description,
  });
  if (body.status === "archived") work = await app.workRepo.archive(workId);
  if (body.status === "active") work = await app.workRepo.unarchive(workId);
  return serializeTransport(work);
});
