/** GET /api/projects/[projectId]/context/sources: the sources the account can read in this project. */

import type { ContextSourcesResult } from "@meridian/contracts/protocol";
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const result: ContextSourcesResult = {
    sources: await app.contextSources.inProject(projectId as never),
  };
  return serializeTransport(result);
});
