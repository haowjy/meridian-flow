import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { handleCommandLookup } from "../../../lib/command-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleCommandLookup(app.commands, {
    userId: user.userId,
    commandId: getRouterParam(event, "commandId") ?? "",
  });
});
