import { defineEventHandler, setResponseStatus } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const bootstrap = await app.projects.ensureDefaultBootstrap(user.userId);
  setResponseStatus(event, 201);
  return bootstrap;
});
