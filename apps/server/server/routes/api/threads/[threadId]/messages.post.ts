import type { SendMessageRequest, SendMessageResponse } from "@meridian/contracts/protocol";
import type { ThreadId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { StaleConnectionTokenError } from "../../../../domains/runtime/loop/turn-runner.js";
import {
  filterAvailableUserMessageImageReferences,
  InvalidUserMessageBlocksError,
  parseUserMessageBlocks,
} from "../../../../domains/runtime/loop/user-message-blocks.js";
import { TurnStartConflictError } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event): Promise<SendMessageResponse> => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as ThreadId;
  const body = (await readBody<SendMessageRequest>(event)) ?? { text: "" };
  if (typeof body.text !== "string" || body.text.length === 0) {
    throw createError({ statusCode: 400, message: "text is required" });
  }

  const thread = await app.threadRuntime.requireOwnedThread(threadId, user.userId);
  try {
    const blocks = parseUserMessageBlocks(body.blocks, body.text);
    const availableBlocks = await filterAvailableUserMessageImageReferences(
      blocks,
      { threadId, projectId: thread.projectId },
      app.imageAssets,
      app.eventSink,
    );
    const result = await app.runner.startTurn({
      threadId,
      userText: body.text,
      userBlocks: body.blocks ? availableBlocks : undefined,
      connectionToken: body.connectionToken,
    });
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
    if (error instanceof InvalidUserMessageBlocksError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    if (error instanceof StaleConnectionTokenError || error instanceof TurnStartConflictError) {
      throw createError({ statusCode: 409, message: error.message });
    }
    throw error;
  }
});
