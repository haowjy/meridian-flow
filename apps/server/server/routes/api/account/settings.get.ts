/** GET /api/account/settings: returns account-level preferences for the authenticated writer. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { handleGetAccountSettings } from "../../../lib/account-settings-route.js";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return serializeTransport(await handleGetAccountSettings(app.users, user.userId));
});
