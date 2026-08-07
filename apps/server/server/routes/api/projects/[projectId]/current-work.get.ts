/** Resolves the authenticated writer's current Work for an owned project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner, resolveCurrentWork } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const project = await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const work = await resolveCurrentWork(
    { works: app.workRepo, preferences: app.preferences },
    user,
    project,
  );
  return serializeTransport(work);
});
