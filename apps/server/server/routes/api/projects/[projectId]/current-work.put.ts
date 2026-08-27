/** Persists the authenticated writer's current Work without moving conversations. */

import { serializeTransport } from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const body = (await readBody<{ workId?: WorkId }>(event)) ?? {};
  const workId = requireRequestId(body.workId, "workId");

  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const work = await app.workRepo.findById(workId);
  if (!work || work.deletedAt || work.projectId !== projectId) {
    throw createError({ statusCode: 404, message: "Work not found" });
  }
  await app.preferences.setCurrentWorkId(user.userId, projectId, work.id);
  return serializeTransport(work);
});
