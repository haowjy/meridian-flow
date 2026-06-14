/** GET /api/projects: lists the authenticated user's projects. Depends on the auth gate and project repository. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";

import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectRepo } = app;
  const { userId } = user;
  const query = getQuery(event);
  const q = typeof query.q === "string" ? query.q.trim() : "";

  const projects =
    q.length > 0 ? await projectRepo.search(userId, q) : await projectRepo.listByUser(userId);

  return serializeTransport({ projects });
});
