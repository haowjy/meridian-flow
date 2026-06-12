/** GET /api/workbenches/[workbenchId]/works: lists works in an owned workbench. Depends on the auth gate, workbench ownership, and work repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { workbenchRepo, workRepo } = app;
  const { userId } = user;
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";

  await requireWorkbenchOwner({ workbenches: workbenchRepo }, workbenchId, userId);
  const works = await workRepo.listByWorkbench(workbenchId);

  return serializeTransport({ works });
});
