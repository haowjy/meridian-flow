/** GET /api/threads: lists the authenticated user's threads across projects. Depends on the auth gate and thread repositories. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";

import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos } = app;
  const { userId } = user;

  const threads = await repos.threads.listByUser(userId);
  return serializeTransport({ threads });
});
