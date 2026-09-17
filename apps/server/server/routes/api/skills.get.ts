import type { ThreadAvailableSkillsResponse } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { requireProjectOwner } from "../../domains/projects/index.js";
import { requireAppUser } from "../../lib/auth-gate.js";
import { parseOptionalRequestId, requireRequestId } from "../../lib/request-id.js";
import { handleGetSelectionAvailableSkills } from "../../lib/selection-available-skills-route.js";

export default defineEventHandler(async (event): Promise<ThreadAvailableSkillsResponse> => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const projectId = parseOptionalRequestId(query.projectId, "projectId");
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  return handleGetSelectionAvailableSkills(
    {
      agentRevisions: app.agentRevisions,
      accountSkillInstalls: app.accountSkillInstalls,
    },
    {
      userId: user.userId,
      catalogEntryId: requireRequestId(query.catalogEntryId, "catalogEntryId"),
      definitionRevisionId: requireRequestId(query.definitionRevisionId, "definitionRevisionId"),
      projectId,
    },
  );
});
