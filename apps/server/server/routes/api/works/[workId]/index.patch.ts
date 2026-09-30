/** Updates mutable Work metadata; archive state remains an explicit lifecycle action. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { UpdateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";
import { updateWorkMetadataForWriter } from "../../../../lib/work-metadata-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const body =
    (await readBody<Partial<Record<keyof UpdateWorkRequest, unknown>> & Record<string, unknown>>(
      event,
    )) ?? {};
  if (body.name !== undefined && typeof body.name !== "string") {
    throw createError({ statusCode: 400, message: "name must be a string" });
  }
  if (body.goal !== undefined && typeof body.goal !== "string") {
    throw createError({ statusCode: 400, message: "goal must be a string" });
  }
  if (body.status !== undefined) {
    throw createError({ statusCode: 400, message: "status is managed by the AI" });
  }

  const work = await updateWorkMetadataForWriter(
    {
      works: app.workRepo,
      projects: app.projectRepo,
      workContextNotices: app.workContextNotices,
    },
    {
      workId,
      userId: user.userId,
      name: body.name as string | undefined,
      goal: body.goal as string | undefined,
    },
  );
  return serializeTransport(work);
});
