/** PATCH /api/workbenches/[workbenchId]: updates an owned workbench's mutable fields. Depends on the auth gate, workbench ownership, and workbench repository. */
import { serializeTransport, type UpdateWorkbenchRequest } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { workbenchRepo } = app;
  const { userId } = user;
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const body = (await readBody<UpdateWorkbenchRequest>(event)) ?? {};

  await requireWorkbenchOwner({ workbenches: workbenchRepo }, workbenchId, userId);
  const workbench = await workbenchRepo.update(workbenchId, {
    title: body.title,
    description: body.description,
  });

  return serializeTransport(workbench);
});
