/** `thread stop`: the chat's Stop, with the body the app builds (`stopRequest` over the newest record). */
import { randomUUID } from "node:crypto";
import {
  apiThreadSnapshotPath,
  apiThreadStopPath,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import type { StopResponse } from "@meridian/contracts/threads";
import { INITIAL_RUN_STATE_VIEW, receiveRecord, stopRequest } from "@meridian/thread-client";
import { type CommandSpec, flag, requirePositional, stringOption } from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { terminalResult } from "./result";

export const threadStopCommand: CommandSpec = {
  path: ["thread", "stop"],
  summary: "Stop the chat: cancel the running reply and hand waiting messages back",
  args: "<thread>",
  route: "POST /api/threads/:threadId/stop",
  options: {
    ...THREAD_TARGET_OPTIONS,
    full: { type: "boolean", description: "Include the handed-back messages' blocks" },
  },
  examples: ["./mf thread stop <id> --json"],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const snapshot = await session.request<ThreadSnapshotResponse>(
      "GET",
      apiThreadSnapshotPath(threadId),
    );
    // `mine` is empty: every message ./mf admitted is in the record at or below `sentThrough`.
    const body = stopRequest(
      receiveRecord(INITIAL_RUN_STATE_VIEW, snapshot.liveState.runState),
      randomUUID(),
    );
    const response = await session.request<StopResponse>("POST", apiThreadStopPath(threadId), body);
    const full = flag(ctx, "full");
    const terminal = terminalResult(
      "thread.stop",
      { outcome: "complete", reason: null },
      {
        threadId,
        cancelledExecutionId: response.cancelledExecutionId,
        handedBack: response.handedBack.map((message) =>
          full ? message : { userTurnId: message.userTurnId },
        ),
        answered: response.answered,
        gone: response.gone,
        next: [`./mf thread tail ${threadId} --until-idle`],
      },
    );
    ctx.out.result(
      terminal.result,
      (value) =>
        `stopped ${value.cancelledExecutionId ?? "(no running reply)"}, handed back ${value.handedBack.length}`,
    );
    return terminal.exitCode;
  },
};
