/** GET /api/workbenches: lists the authenticated user's workbenches. Depends on the auth gate and workbench repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";

import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { workbenchRepo } = app;
  const { userId } = user;
  const query = getQuery(event);
  const q = typeof query.q === "string" ? query.q.trim() : "";

  const workbenches =
    q.length > 0 ? await workbenchRepo.search(userId, q) : await workbenchRepo.listByUser(userId);

  return serializeTransport({ workbenches });
});
