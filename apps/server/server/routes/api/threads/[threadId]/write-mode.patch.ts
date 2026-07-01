/** PATCH /api/threads/:threadId/write-mode: updates a thread's AI write mode, guarded by active draft state. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  handleThreadWriteModeRequest,
  selectThreadWriteModeServices,
} from "../../../../lib/thread-write-mode-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<{ aiWriteMode?: unknown }>(event)) ?? {};
  return handleThreadWriteModeRequest(selectThreadWriteModeServices(app), {
    threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
    userId: user.userId,
    aiWriteMode: body.aiWriteMode,
  });
});
