/** GET /api/projects/[projectId]/works: lists works in an owned project. Depends on the auth gate, project ownership, and work repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { listWorkCatalog } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo, workRepo, documentSync } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";
  const snapshot = await listWorkCatalog(
    { projects: projectRepo, works: workRepo, pendingDrafts: documentSync },
    {
      projectId: projectId as ProjectId,
      userId: userId as UserId,
    },
  );

  return serializeTransport(snapshot);
});
