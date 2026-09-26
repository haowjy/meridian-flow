/** GET /api/debug/mock-model/script — dev-only: queued mock-model scripts. */
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { readMockModelScripts } from "../../../../lib/mock-model-script-route.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  return readMockModelScripts(app.mockModelScript);
});
