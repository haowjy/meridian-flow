/** GET /api/projects/[projectId]/threads/by-ref/[ref]: resolves a live cN/pN thread handle in an owned project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { handleGetThreadByRef } from "../../../../../../lib/thread-ref-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const thread = await handleGetThreadByRef(
    { projectRepo: app.projectRepo, threads: app.repos.threads },
    {
      projectId: getRouterParam(event, "projectId") ?? "",
      userId: user.userId,
      ref: decodeURIComponent(getRouterParam(event, "ref") ?? ""),
    },
  );
  return serializeTransport(thread);
});
