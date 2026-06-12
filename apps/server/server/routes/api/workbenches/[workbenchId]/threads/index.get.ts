/** GET /api/workbenches/[workbenchId]/threads: lists threads in an owned workbench. Depends on the auth gate, workbench ownership, and thread repositories. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, workbenchRepo } = app;
  const { userId } = user;
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";

  await requireWorkbenchOwner({ workbenches: workbenchRepo }, workbenchId, userId);
  const threads = await repos.threads.listByWorkbench(workbenchId);

  return serializeTransport({ threads });
});
