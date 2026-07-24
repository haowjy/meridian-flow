/** GET /api/projects/[projectId]/works/[workId]/threads: lists threads for a work in an owned project. Depends on auth, project ownership, and thread projections. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");

  await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  const threads = await repos.threads.listByWork(projectId, workId);

  return serializeTransport({ threads });
});
