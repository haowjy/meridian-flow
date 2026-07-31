/** Creates a named Work in an owned project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import {
  requireProjectOwner,
  WorkNameConflictError,
} from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { parseOptionalRequestId, requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const body = (await readBody<Partial<Record<keyof CreateWorkRequest, unknown>>>(event)) ?? {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw createError({ statusCode: 400, message: "name is required" });
  if (body.goal !== undefined && typeof body.goal !== "string") {
    throw createError({ statusCode: 400, message: "goal must be a string" });
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    throw createError({ statusCode: 400, message: "description must be a string" });
  }

  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const work = await app.workRepo
    .create({
      id: parseOptionalRequestId(body.id, "id"),
      projectId,
      createdByUserId: user.userId,
      name,
      goal: body.goal,
      description: body.description,
    })
    .catch((error: unknown) => {
      if (error instanceof WorkNameConflictError) {
        throw createError({ statusCode: 409, message: error.message });
      }
      throw error;
    });
  await app.preferences.setCurrentWorkId(user.userId, projectId, work.id);

  event.res.status = 201;
  return serializeTransport(work);
});
