import type { ThreadAvailableSkillsResponse } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { handleGetThreadAvailableSkills } from "../../../../lib/thread-available-skills-route.js";

export default defineEventHandler(async (event): Promise<ThreadAvailableSkillsResponse> => {
  const { app, user } = await requireAppUser(event);
  return handleGetThreadAvailableSkills(
    {
      repos: app.repos,
      projectRepo: app.projectRepo,
      agentRevisions: app.agentRevisions,
      accountSkillInstalls: app.accountSkillInstalls,
    },
    { threadId: getRouterParam(event, "threadId") ?? "", userId: user.userId },
  );
});
