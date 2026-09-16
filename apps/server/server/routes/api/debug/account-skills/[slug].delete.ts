/** DELETE /api/debug/account-skills/:slug — authenticated, dev-only, idempotent. */
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  assertDebugAccountSkillsEnabled,
  handleDeleteDebugAccountSkill,
} from "../../../../lib/debug-account-skills-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  assertDebugAccountSkillsEnabled();
  await handleDeleteDebugAccountSkill({
    installs: app.accountSkillInstalls,
    ownerUserId: user.userId,
    slug: getRouterParam(event, "slug") ?? "",
  });
  setResponseStatus(event, 204);
});
