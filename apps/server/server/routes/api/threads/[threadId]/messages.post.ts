import type { SendMessageRequest, SendMessageResponse } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import {
  AdmissionConflictError,
  InvalidAdmissionError,
} from "../../../../domains/runtime/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event): Promise<SendMessageResponse> => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as ThreadId;
  const body = ((await readBody<SendMessageRequest>(event)) ?? {}) as SendMessageRequest;
  await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  try {
    const result = await app.userTurnAdmission.admit({
      actorUserId: user.userId,
      threadId,
      submissionId: body.submissionId,
      text: body.text,
      blocks: body.blocks,
      references: body.references,
      connectionToken: body.connectionToken,
    });
    if (result.kind === "pending") {
      throw createError({ statusCode: 409, message: "admission_pending" });
    }
    if (result.kind === "rejected") {
      throw createError({
        statusCode: result.code === "invalid_message" ? 400 : 409,
        message: result.code,
      });
    }
    setResponseStatus(event, 202);
    return {
      threadId,
      userTurnId: result.userTurnId,
      assistantTurnId: result.assistantTurnId,
      resumeAfterSeq: result.resumeAfterSeq,
      snapshotFloorNextSeq: result.snapshotFloorNextSeq,
      status: "accepted",
    };
  } catch (error) {
    if (error instanceof InvalidAdmissionError)
      throw createError({ statusCode: 400, message: error.code });
    if (error instanceof AdmissionConflictError)
      throw createError({ statusCode: 409, message: error.code });
    throw error;
  }
});
