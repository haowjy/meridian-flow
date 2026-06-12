/**
 * PATCH /api/workbenches/[workbenchId]/agents/[slug]/skills/[skillSlug]
 *
 * Immediate operational mutation for per-link `modelInvocable`. This is
 * workbench settings state — not versioned definition content — so it does
 * not append a revision row (contrast with PUT on the agent definition).
 */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../../lib/auth-gate.js";
import {
  handlePatchAgentSkillLinkRequest,
  parsePatchAgentSkillLinkRequest,
} from "../../../../../../../../lib/workbench-definitions-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const slug = getRouterParam(event, "slug") ?? "";
  const skillSlug = getRouterParam(event, "skillSlug") ?? "";
  const body = parsePatchAgentSkillLinkRequest(await readBody(event));

  const agent = await handlePatchAgentSkillLinkRequest(
    { workbenchRepo: app.workbenchRepo, packageRepository: app.packageRepository },
    { workbenchId, userId: user.userId, slug, skillSlug, body },
  );

  return serializeTransport(agent);
});
