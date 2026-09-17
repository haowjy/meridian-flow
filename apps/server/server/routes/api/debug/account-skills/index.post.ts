/** POST /api/debug/account-skills — authenticated, dev-only account skill install. */
import { defineEventHandler, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  assertDebugAccountSkillsEnabled,
  handleAddDebugAccountSkill,
  parseDebugAccountSkillAdd,
} from "../../../../lib/debug-account-skills-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  assertDebugAccountSkillsEnabled();
  return handleAddDebugAccountSkill({
    installs: app.accountSkillInstalls,
    agentRevisions: app.agentRevisions,
    ownerUserId: user.userId,
    body: parseDebugAccountSkillAdd(await readBody(event)),
  });
});
