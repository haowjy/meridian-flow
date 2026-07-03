/** PATCH /api/projects/:projectId/works/:workId/write-mode: updates Work-owned AI write mode. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  handleWorkWriteModeRequest,
  selectWorkWriteModeServices,
} from "../../../../../../lib/work-write-mode-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const workId = getRouterParam(event, "workId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);

  const body = (await readBody<{ aiWriteMode?: unknown }>(event)) ?? {};
  const result = await handleWorkWriteModeRequest(selectWorkWriteModeServices(app), {
    projectId,
    workId,
    userId: user.userId,
    aiWriteMode: body.aiWriteMode,
  });

  return serializeTransport(result);
});
