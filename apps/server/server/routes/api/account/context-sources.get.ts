/** GET /api/account/context-sources: the account's own sources (`user://`). */
import type { ContextSourcesResult } from "@meridian/contracts/protocol";
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const result: ContextSourcesResult = { sources: await app.contextSources.ofUser(user.userId) };
  return serializeTransport(result);
});
