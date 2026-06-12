/** GET /api/workbenches/[workbenchId]/stats: returns Home destination aggregate stats for an owned workbench. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { computeWorkbenchStats } from "../../../../lib/workbench-stats.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, workbenchRepo, workRepo } = app;
  const { userId } = user;
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";

  await requireWorkbenchOwner({ workbenches: workbenchRepo }, workbenchId, userId);
  const [threads, works] = await Promise.all([
    repos.threads.listByWorkbench(workbenchId),
    workRepo.listByWorkbench(workbenchId),
  ]);

  return serializeTransport(computeWorkbenchStats(threads, works));
});
