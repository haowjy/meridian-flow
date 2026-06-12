/** DELETE /api/workbenches/[workbenchId]: soft-deletes a workbench (idempotent). Depends on the auth gate, workbench ownership, and workbench repository. */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireWorkbenchOwner } from "../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { workbenchRepo } = app;
  const { userId } = user;
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";

  const workbench = await requireWorkbenchOwner(
    { workbenches: workbenchRepo },
    workbenchId,
    userId,
    {
      includeSoftDeleted: true,
    },
  );
  if (!workbench.deletedAt) {
    await workbenchRepo.softDelete(workbenchId);
  }

  setResponseStatus(event, 204);
});
