/** Creates a named Work in an owned project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { parseOptionalRequestId, requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const body = (await readBody<CreateWorkRequest>(event)) ?? ({} as CreateWorkRequest);
  const name = body.name?.trim();
  if (!name) throw createError({ statusCode: 400, message: "name is required" });

  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const work = await app.workRepo.create({
    id: parseOptionalRequestId(body.id, "id"),
    projectId,
    createdByUserId: user.userId,
    name,
    goal: body.goal,
    description: body.description,
  });

  event.res.status = 201;
  return serializeTransport(work);
});
