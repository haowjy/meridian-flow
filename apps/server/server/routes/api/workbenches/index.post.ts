/** POST /api/workbenches: creates a workbench for the authenticated user. Depends on the auth gate and workbench repository. */
import { type CreateWorkbenchRequest, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";

import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { workbenchRepo } = app;
  const { userId } = user;
  const body = (await readBody<CreateWorkbenchRequest>(event)) ?? { title: "" };
  if (!body.title?.trim()) {
    throw createError({ statusCode: 400, message: "title is required" });
  }

  const workbench = await workbenchRepo.create({
    id: body.id,
    userId,
    title: body.title.trim(),
    description: body.description ?? null,
  });

  await app.seedDefaultPackagesForWorkbench(workbench.id);

  event.res.status = 201;
  return serializeTransport(workbench);
});
