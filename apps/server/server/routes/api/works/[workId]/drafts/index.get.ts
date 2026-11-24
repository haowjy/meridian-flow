import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleListWorkDrafts } from "../../../../../lib/work-drafts-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  return handleListWorkDrafts(app, {
    workId: getRouterParam(event, "workId"),
    userId: user.userId,
  });
});
