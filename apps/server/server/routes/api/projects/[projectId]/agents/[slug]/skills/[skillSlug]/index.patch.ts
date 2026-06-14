/**
 * PATCH /api/projects/[projectId]/agents/[slug]/skills/[skillSlug]
 *
 * Immediate operational mutation for per-link `modelInvocable`. This is
 * project settings state — not versioned definition content — so it does
 * not append a revision row (contrast with PUT on the agent definition).
 */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import {
  handlePatchAgentSkillLinkRequest,
  parsePatchAgentSkillLinkRequest,
} from "../../../../../../../../lib/project-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const skillSlug = getRouterParam(event, "skillSlug") ?? "";
  const body = parsePatchAgentSkillLinkRequest(await readBody(event));

  const agent = await handlePatchAgentSkillLinkRequest(
    { projectRepo: app.projectRepo, packageRepository: app.packageRepository },
    { projectId, userId: user.userId, slug, skillSlug, body },
  );

  return serializeTransport(agent);
});
