/** Creates a named Work in an owned project. */

import type { CommandId } from "@meridian/contracts";
import { serializeTransport } from "@meridian/contracts/protocol";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import {
  createWork,
  requireProjectOwner,
  WorkNameConflictError,
  WorkNameRequiredError,
} from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { splitCommandBody } from "../../../../../lib/command-route.js";
import { parseOptionalRequestId, requireRequestId } from "../../../../../lib/request-id.js";
import { runWorkCommand } from "../../../../../lib/work-command.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const { commandId, body } = splitCommandBody(await readBody(event)) as {
    commandId: CommandId;
    body: Partial<Record<keyof CreateWorkRequest, unknown>>;
  };
  const name = body.name;
  if (typeof name !== "string") throw createError({ statusCode: 400, message: "name is required" });
  if (body.goal !== undefined && typeof body.goal !== "string") {
    throw createError({ statusCode: 400, message: "goal must be a string" });
  }
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const work = await runWorkCommand(
    app.commands,
    { commandId, userId: user.userId, projectId, kind: "work_create", body },
    () =>
      createWork(
        { works: app.workRepo },
        {
          id: parseOptionalRequestId(body.id, "id"),
          projectId,
          createdByUserId: user.userId,
          name,
          goal: body.goal as string | undefined,
        },
      ),
  ).catch((error: unknown) => {
    if (error instanceof WorkNameRequiredError) {
      throw createError({ statusCode: 400, message: "name is required" });
    }
    if (error instanceof WorkNameConflictError) {
      throw createError({ statusCode: 409, message: error.message });
    }
    throw error;
  });

  event.res.status = 201;
  return serializeTransport(work);
});
