/** GET /api/projects/[projectId]/works: lists works in an owned project. Depends on the auth gate, project ownership, and work repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { WorkStatus } from "@meridian/contracts/works";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo, workRepo, documentSync } = app;
  const { userId } = user;
  const projectId = getRouterParam(event, "projectId") ?? "";
  const rawStatus = getQuery(event).status;
  if (
    rawStatus !== undefined &&
    rawStatus !== "active" &&
    rawStatus !== "archived" &&
    rawStatus !== "all"
  ) {
    throw createError({ statusCode: 400, message: "status must be active, archived, or all" });
  }
  const status = rawStatus ?? "active";

  await requireProjectOwner({ projects: projectRepo }, projectId, userId);
  const works = await workRepo.listByProject(
    projectId,
    status === "all" ? undefined : { status: status as WorkStatus },
  );
  const enrichedWorks = await Promise.all(
    works.map(async (work) => ({
      ...work,
      unpushedChangeCount: await documentSync.countUnpushedRowsForWork(work.id),
    })),
  );

  return serializeTransport({ works: enrichedWorks });
});
