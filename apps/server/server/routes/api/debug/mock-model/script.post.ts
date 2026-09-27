/** POST /api/debug/mock-model/script — dev-only: queue scripted mock-model replies. */
import { defineEventHandler, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { enqueueMockModelScript } from "../../../../lib/mock-model-script-route.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  return enqueueMockModelScript(app.mockModelScript, await readBody(event));
});
