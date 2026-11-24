import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const rootThreadId = requireRequestId(getRouterParam(event, "rootThreadId"), "rootThreadId");
  const lineage = await app.contextPorts.lineages.byId(projectId, rootThreadId);
  if (!lineage) throw createError({ statusCode: 404, message: "Chat not found" });
  return serializeTransport({
    rootThreadId: lineage.rootThreadId,
    rootThreadRef: lineage.rootThreadRef,
    title: lineage.title ?? null,
  });
});
