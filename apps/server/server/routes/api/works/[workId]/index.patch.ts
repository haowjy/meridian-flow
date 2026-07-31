/** Updates mutable Work metadata; archive state remains an explicit lifecycle action. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { UpdateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireWorkOwner, WorkNameConflictError } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const body = (await readBody<Partial<Record<keyof UpdateWorkRequest, unknown>>>(event)) ?? {};
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
    throw createError({ statusCode: 400, message: "name must be a non-empty string" });
  }
  if (body.goal !== undefined && typeof body.goal !== "string") {
    throw createError({ statusCode: 400, message: "goal must be a string" });
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw createError({ statusCode: 400, message: "description must be a string" });
  }
  if (body.status !== undefined && body.status !== "active" && body.status !== "archived") {
    throw createError({ statusCode: 400, message: "status must be active or archived" });
  }

  await requireWorkOwner({ works: app.workRepo, projects: app.projectRepo }, workId, user.userId);
  let work = await app.workRepo
    .update(workId, {
      name: body.name?.trim(),
      goal: body.goal,
      description: body.description,
    })
    .catch((error: unknown) => {
      if (error instanceof WorkNameConflictError) {
        throw createError({ statusCode: 409, message: error.message });
      }
      throw error;
    });
  if (body.status === "archived") work = await app.workRepo.archive(workId);
  if (body.status === "active") work = await app.workRepo.unarchive(workId);
  return serializeTransport(work);
});
