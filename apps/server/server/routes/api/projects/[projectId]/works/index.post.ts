import { type CommandId, type DraftId, isDraftId } from "@meridian/contracts";
import { serializeTransport } from "@meridian/contracts/protocol";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import {
  createWork,
  requireProjectOwner,
  WorkNameRequiredError,
} from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { splitCommandBody } from "../../../../../lib/command-route.js";
import { parseOptionalRequestId, requireRequestId } from "../../../../../lib/request-id.js";
import { runWorkCommand, workAnswer } from "../../../../../lib/work-command.js";

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
  if (body.draftId !== undefined && !isDraftId(body.draftId)) {
    throw createError({ statusCode: 400, message: "draftId must be a draft id" });
  }
  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const work = await runWorkCommand(
    app.commands,
    { commandId, userId: user.userId, projectId, kind: "work_create", body },
    async () => ({
      work: await createWork(
        { works: app.workRepo },
        {
          id: parseOptionalRequestId(body.id, "id"),
          ...(body.draftId !== undefined ? { draftId: body.draftId as DraftId } : {}),
          projectId,
          createdByUserId: user.userId,
          name,
          goal: body.goal as string | undefined,
        },
      ),
    }),
  ).catch((error: unknown) => {
    if (error instanceof WorkNameRequiredError) {
      throw createError({ statusCode: 400, message: "name is required" });
    }
    throw error;
  });

  event.res.status = 201;
  return serializeTransport(workAnswer(work));
});
