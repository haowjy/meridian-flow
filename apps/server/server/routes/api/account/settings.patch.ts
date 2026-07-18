/** PATCH /api/account/settings: strictly updates account-level preferences for the authenticated writer. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, readBody } from "nitro/h3";
import {
  handlePatchAccountSettings,
  parseAccountSettingsPatch,
} from "../../../lib/account-settings-route.js";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const settings = parseAccountSettingsPatch(await readBody(event));
  return serializeTransport(await handlePatchAccountSettings(app.users, user.userId, settings));
});
