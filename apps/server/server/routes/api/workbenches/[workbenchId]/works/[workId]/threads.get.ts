/** GET /api/workbenches/[workbenchId]/works/[workId]/threads: lists threads for a work in an owned workbench. Depends on auth, workbench ownership, and thread projections. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, workbenchRepo } = app;
  const { userId } = user;
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const workId = getRouterParam(event, "workId") ?? "";

  await requireWorkbenchOwner({ workbenches: workbenchRepo }, workbenchId, userId);
  const threads = await repos.threads.listByWork(workbenchId, workId);

  return serializeTransport({ threads });
});
