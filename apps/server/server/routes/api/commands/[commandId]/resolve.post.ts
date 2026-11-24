import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { handleCommandResolve } from "../../../../lib/command-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleCommandResolve(app.commands, {
    userId: user.userId,
    commandId: getRouterParam(event, "commandId") ?? "",
    body: await readBody(event),
  });
});
