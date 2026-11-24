import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";

import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { threadRepos } = app;
  const { userId } = user;

  const threads = await threadRepos.threads.listByUser(userId);
  return serializeTransport({ threads });
});
