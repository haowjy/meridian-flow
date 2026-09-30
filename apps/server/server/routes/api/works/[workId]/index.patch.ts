/** Updates mutable Work metadata; archive state remains an explicit lifecycle action. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { UpdateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import {
  requireWorkOwner,
  updateActiveWorkMetadata,
  WorkLifecycleUnavailableError,
  WorkNameConflictError,
  WorkNameRequiredError,
} from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

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
    throw createError({ statusCode: 400, message: "status is changed through archive actions" });
  }

  await requireWorkOwner({ works: app.workRepo, projects: app.projectRepo }, workId, user.userId);
  const transition = await updateActiveWorkMetadata(
    { works: app.workRepo, workContextNotices: app.workContextNotices },
    workId,
    {
      name: body.name as string | undefined,
      goal: body.goal as string | undefined,
    },
  ).catch((error: unknown) => {
    if (error instanceof WorkNameRequiredError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    if (error instanceof WorkNameConflictError) {
      throw createError({ statusCode: 409, message: error.message });
    }
    if (error instanceof WorkLifecycleUnavailableError) {
      throw createError({ statusCode: 409, message: error.message });
    }
    throw error;
  });
  return serializeTransport(transition.after);
});
