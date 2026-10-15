/**
 * `thread stop`: the chat's Stop, with the body the app builds (`stopRequest` over the newest record).
 * The request (id and frozen body) is printed before posting, so a lost answer can be replayed
 * with `--replay`: the server returns its stored decision for the same id and body, and the
 * handed-back text with it. A re-run without `--replay` is a new press and may cancel the next reply.
 */
import { randomUUID } from "node:crypto";
import {
  apiThreadSnapshotPath,
  apiThreadStopPath,
  stopRequestSchema,
  stopResponseSchema,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import type { StopRequest, StopResponse } from "@meridian/contracts/threads";
import { INITIAL_RUN_STATE_VIEW, receiveRecord, stopRequest } from "@meridian/thread-client";
import { CliError, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  flag,
  readJsonArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import type { Session } from "../../core/session";
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
    replay: {
      type: "string",
      description:
        "Post exactly this printed Stop request (JSON, @file, or -) with no new snapshot; recovers a lost answer",
    },
  },
  examples: ["./mf thread stop <id> --json", "./mf thread stop <id> --replay @stop-request.json"],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const replay = stringOption(ctx, "replay");
    let body: StopRequest;
    if (replay !== undefined) {
      const parsed = stopRequestSchema.safeParse(readJsonArg(replay, "--replay"));
      if (!parsed.success) throw usageError("--replay is not a printed Stop request");
      body = parsed.data;
    } else {
      const snapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
      );
      // `mine` is empty: every message ./mf admitted is in the record at or below `sentThrough`.
      body = stopRequest(
        receiveRecord(INITIAL_RUN_STATE_VIEW, snapshot.liveState.runState),
        randomUUID(),
      );
    }
    const requestJson = JSON.stringify(body);
    ctx.out.note(`stop request ${requestJson}`);
    const response = await postStop(session, threadId, body, requestJson);
    const full = flag(ctx, "full");
    const terminal = terminalResult(
      "thread.stop",
      { outcome: "complete", reason: null },
      {
        threadId,
        request: body,
        cancelledExecutionId: response.cancelledExecutionId,
        handedBack: response.handedBack.map((message) =>
          full ? message : { userTurnId: message.userTurnId },
        ),
        answered: response.answered,
        gone: response.gone,
        next: [`./mf thread tail ${threadId} --until-idle`],
      },
    );
    ctx.out.result(terminal.result, (value) => {
      const summary = `stopped ${value.cancelledExecutionId ?? "(no running reply)"}, handed back ${value.handedBack.length}`;
      if (!full) return summary;
      // In send order, blank lines between messages: what the app's composer would receive.
      const texts = response.handedBack.map((message) =>
        message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
      );
      return [summary, ...texts].join("\n\n");
    });
    return terminal.exitCode;
  },
};

/**
 * Posts the frozen request and confirms it only from an answer `stopResponseSchema` accepts in
 * full. Any failure to read or validate the answer (no answer, a 5xx, an oversized or malformed
 * body) leaves the press possibly landed, so it is an ambiguity carrying the request in every
 * output mode. Only a definite refusal (a 4xx status) drops the recovery path.
 */
async function postStop(
  session: Session,
  threadId: string,
  body: StopRequest,
  requestJson: string,
): Promise<StopResponse> {
  let failure: string;
  try {
    const parsed = stopResponseSchema.safeParse(
      await session.request("POST", apiThreadStopPath(threadId), body),
    );
    if (parsed.success) return parsed.data as StopResponse;
    failure = "the answer is not a Stop response";
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const status = error.httpStatus;
    if (status !== undefined && status >= 400 && status < 500) throw error;
    failure = error.message;
  }
  throw new CliError("unavailable", `Stop answer lost (${failure})`, {
    hint: `The Stop may have landed. Replay the same request, not a new press: echo '${requestJson}' | ./mf thread stop ${threadId} --replay -`,
    details: { threadId, request: body },
  });
}
