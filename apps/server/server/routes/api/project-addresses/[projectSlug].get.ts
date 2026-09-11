/** Resolves an authenticated owner's readable project address to its stable identity. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, setHeader } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  setHeader(event, "Cache-Control", "private, no-store");
  const slug = getRouterParam(event, "projectSlug") ?? "";
  const project = await app.projectRepo.findLiveByOwnerSlug(user.userId, slug);
  if (!project)
    throw createError({
      statusCode: 404,
      message: "Project not found",
      headers: { "Cache-Control": "private, no-store" },
    });
  return serializeTransport(project);
});
