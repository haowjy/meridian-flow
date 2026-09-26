/** DELETE /api/debug/mock-model/script[?id=] — drop one queued mock-model script, or all. */
import { defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { clearMockModelScripts } from "../../../../lib/mock-model-script-route.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  const { id } = getQuery(event);
  return clearMockModelScripts(app.mockModelScript, typeof id === "string" ? id : undefined);
});
