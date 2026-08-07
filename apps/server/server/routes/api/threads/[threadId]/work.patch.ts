/** Reassigns a conversation's primary Work after the D18 pending-draft guard. */

import { serializeTransport } from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import {
  InvalidThreadWorkTargetError,
  PendingDraftWorkReassignmentError,
  reassignThreadPrimaryWork,
  requireThreadOwner,
} from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const body = (await readBody<{ workId?: WorkId }>(event)) ?? {};
  const workId = requireRequestId(body.workId, "workId");
  const thread = await requireThreadOwner(
    { threads: app.repos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );

  try {
    const result = await reassignThreadPrimaryWork(
      { works: app.workRepo, threadWorks: app.repos.threadWorks },
      { threadId: thread.id, projectId: thread.projectId, workId },
    );
    return serializeTransport(result);
  } catch (error) {
    if (error instanceof PendingDraftWorkReassignmentError) {
      throw createError({ statusCode: 409, message: error.message });
    }
    if (error instanceof InvalidThreadWorkTargetError) {
      throw createError({ statusCode: 404, message: "Work not found" });
    }
    throw error;
  }
});
