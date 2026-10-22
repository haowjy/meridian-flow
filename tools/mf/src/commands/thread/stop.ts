/**
 * `thread stop`: the chat's Stop, run by the shared hand-back operation with the body the app
 * builds (`stopRequest` over the newest record). The adapter prints the request (id and frozen
 * body) and the exact replay command before posting, so a lost answer can be replayed with
 * `--replay`: the server returns its stored decision for the same id and body, and the
 * handed-back text with it. A re-run without `--replay` is a new press and may cancel the next reply.
 */
import {
  apiThreadSnapshotPath,
  stopRequestSchema,
  threadSnapshotSchema,
} from "@meridian/contracts/protocol";
import { usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  flag,
  readJsonArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import { jsonResponse } from "../../core/session";
import { runHandBack } from "./hand-back-adapter";
import { handedBackText, viewOfSnapshot } from "./queue-output";
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
    const replayCommand = `./mf thread stop ${threadId}`;
    let input: Parameters<typeof runHandBack>[0]["input"];
    if (replay !== undefined) {
      const parsed = stopRequestSchema.safeParse(readJsonArg(replay, "--replay"));
      if (!parsed.success) throw usageError("--replay is not a printed Stop request");
      input = { replay: { kind: "stop", requestId: parsed.data.requestId, body: parsed.data } };
    } else {
      const snapshot = await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
        decode: jsonResponse(threadSnapshotSchema),
      });
      // `mine` is empty: every message ./mf admitted is in the record at or below `sentThrough`.
      input = { press: { kind: "stop", view: viewOfSnapshot(snapshot) } };
    }
    const { command, result, cancelledExecutionId } = await runHandBack({
      out: ctx.out,
      session,
      threadId,
      label: "stop",
      replayCommand,
      input,
    });
    const full = flag(ctx, "full");
    const terminal = terminalResult(
      "thread.stop",
      { outcome: "complete", reason: null },
      {
        threadId,
        request: command.kind === "stop" ? command.body : null,
        cancelledExecutionId,
        handedBack: result.handedBack.map((message) =>
          full ? message : { userTurnId: message.userTurnId },
        ),
        answered: result.answered,
        gone: result.gone,
        next: [`./mf thread tail ${threadId} --until-idle`],
      },
    );
    ctx.out.result(terminal.result, (value) => {
      const summary = `stopped ${value.cancelledExecutionId ?? "(no running reply)"}, handed back ${value.handedBack.length}`;
      return full ? handedBackText(summary, result.handedBack) : summary;
    });
    return terminal.exitCode;
  },
};
