/**
 * `thread queue hand-back` and `thread queue send-now`: the chat queue's x / Cancel queue and Send
 * now, over the same shared operation and folds the app runs. `./mf` holds no server rules: it
 * builds the body from a fresh snapshot (or takes `--replay`), prints the frozen request and the
 * exact replay command before posting, and reads the answer into output and an exit code.
 */
import { randomUUID } from "node:crypto";
import {
  apiThreadSnapshotPath,
  handBackRequestSchema,
  sendNowRequestSchema,
  threadSnapshotSchema,
} from "@meridian/contracts/protocol";
import type { SendNowRequest } from "@meridian/contracts/threads";
import { postSendNow, sendNowRequest, waitingWriterMessages } from "@meridian/thread-client";
import { usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  flag,
  listOption,
  readJsonArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import {
  ambiguousError,
  printFrozenRequest,
  refusedError,
  runHandBack,
  sessionHttp,
} from "./hand-back-adapter";
import { handedBackText, viewOfSnapshot } from "./queue-output";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { terminalResult } from "./result";

export const threadQueueHandBackCommand: CommandSpec = {
  path: ["thread", "queue", "hand-back"],
  summary: "Take queued messages back (the queue's x and Cancel queue); never cancels the reply",
  args: "<thread>",
  route: "POST /api/threads/:threadId/hand-back",
  options: {
    ...THREAD_TARGET_OPTIONS,
    id: {
      type: "string",
      multiple: true,
      description: "A queued message's user turn id (repeatable)",
    },
    all: {
      type: "boolean",
      description: "Every message the snapshot shows queued, browser messages included",
    },
    full: { type: "boolean", description: "Include the handed-back messages' blocks and text" },
    replay: {
      type: "string",
      description: "Post exactly this printed request (JSON, @file, or -); recovers a lost answer",
    },
  },
  examples: [
    "./mf thread queue hand-back <id> --all --json",
    "./mf thread queue hand-back <id> --id <turnId> --id <turnId2>",
    `./mf thread queue hand-back <id> --replay '{"requestId":"...","ids":["..."]}'`,
  ],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const replay = stringOption(ctx, "replay");
    const ids = listOption(ctx, "id");
    const all = flag(ctx, "all");
    if (replay !== undefined && (all || ids.length > 0))
      throw usageError("--replay posts a printed request; it takes no --id or --all");
    if (replay === undefined && all === ids.length > 0)
      throw usageError("Give --id <turn>... or --all");
    const replayCommand = `./mf thread queue hand-back ${threadId}`;
    const full = flag(ctx, "full");

    let requested: string[];
    let input: Parameters<typeof runHandBack>[0]["input"];
    if (replay !== undefined) {
      const parsed = handBackRequestSchema.safeParse(readJsonArg(replay, "--replay"));
      if (!parsed.success) throw usageError("--replay is not a printed hand-back request");
      requested = parsed.data.ids;
      input = {
        replay: { kind: "queue", requestId: parsed.data.requestId, ids: parsed.data.ids },
      };
    } else {
      if (all) {
        const snapshot = await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
          parse: threadSnapshotSchema.safeParse,
        });
        requested = waitingWriterMessages(viewOfSnapshot(snapshot)).map((item) => item.id);
        if (requested.length === 0) {
          const nothing = terminalResult(
            "thread.queue.hand-back",
            { outcome: "complete", reason: null },
            { threadId, request: null, handedBack: [], answered: [], gone: [], ignored: [] },
          );
          ctx.out.result(nothing.result, () => "nothing waits (from the snapshot just read)");
          return nothing.exitCode;
        }
      } else {
        requested = ids;
      }
      const checked = handBackRequestSchema.safeParse({ requestId: randomUUID(), ids: requested });
      if (!checked.success) throw usageError("--id values must be user turn ids (1 to 500)");
      input = { press: { kind: "queue", ids: requested } };
    }

    const { command, result } = await runHandBack({
      out: ctx.out,
      session,
      threadId,
      label: "hand-back",
      replayCommand,
      input,
    });
    const covered = new Set([
      ...result.handedBack.map((message) => message.userTurnId),
      ...result.answered,
      ...result.gone,
    ]);
    const ignored = requested.filter((id) => !covered.has(id));
    const terminal = terminalResult(
      "thread.queue.hand-back",
      ignored.length > 0
        ? { outcome: "failed", reason: "not_a_message" }
        : { outcome: "complete", reason: null },
      {
        threadId,
        request:
          command.kind === "queue" ? { requestId: command.requestId, ids: command.ids } : null,
        handedBack: result.handedBack.map((message) =>
          full ? message : { userTurnId: message.userTurnId },
        ),
        answered: result.answered,
        gone: result.gone,
        ignored,
      },
    );
    ctx.out.result(terminal.result, (value) => {
      const summary = `handed back ${value.handedBack.length}, answered ${value.answered.length} (the reply took them first), gone ${value.gone.length}${
        ignored.length > 0
          ? `, ignored ${ignored.length} (not_a_message: ${ignored.join(" ")})`
          : ""
      }`;
      return full ? handedBackText(summary, result.handedBack) : summary;
    });
    return terminal.exitCode;
  },
};

export const threadQueueSendNowCommand: CommandSpec = {
  path: ["thread", "queue", "send-now"],
  summary: "Send now: ask the server to cancel the running reply so the waiting queue can run",
  args: "<thread>",
  route: "POST /api/threads/:threadId/send-now",
  options: {
    ...THREAD_TARGET_OPTIONS,
    replay: {
      type: "string",
      description:
        "Post exactly this printed Send now body (JSON, @file, or -); recovers a lost answer",
    },
  },
  examples: [
    "./mf thread queue send-now <id> --json",
    `./mf thread queue send-now <id> --replay '{"seenThrough":1,"seenExecutionId":"...","waiting":["..."]}'`,
  ],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const replay = stringOption(ctx, "replay");
    const replayCommand = `./mf thread queue send-now ${threadId}`;
    let body: SendNowRequest | null;
    if (replay !== undefined) {
      const parsed = sendNowRequestSchema.safeParse(readJsonArg(replay, "--replay"));
      if (!parsed.success) throw usageError("--replay is not a printed Send now body");
      body = parsed.data;
    } else {
      const snapshot = await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
        parse: threadSnapshotSchema.safeParse,
      });
      body = sendNowRequest(viewOfSnapshot(snapshot));
    }
    if (!body) {
      const nothing = terminalResult(
        "thread.queue.send-now",
        { outcome: "complete", reason: null },
        { threadId, request: null, cancelledExecutionId: null },
      );
      ctx.out.result(
        nothing.result,
        () => "nothing to send now (the snapshot just read shows no running reply with a queue)",
      );
      return nothing.exitCode;
    }
    printFrozenRequest(ctx.out, "send-now", body, replayCommand);
    const outcome = await postSendNow(
      { http: sessionHttp(session), runState: { receive: () => {} } },
      threadId,
      body,
    );
    if (outcome.kind === "refused") throw refusedError("send-now", outcome.status);
    if (outcome.kind === "ambiguous")
      throw ambiguousError("send-now", threadId, outcome.request, replayCommand);
    const terminal = terminalResult(
      "thread.queue.send-now",
      { outcome: "complete", reason: null },
      {
        threadId,
        request: body,
        cancelledExecutionId: outcome.cancelledExecutionId,
        next: [`./mf thread tail ${threadId} --until-idle`],
      },
    );
    ctx.out.result(terminal.result, (value) =>
      value.cancelledExecutionId === null
        ? "this attempt requested no cancellation"
        : `requested cancellation of ${value.cancelledExecutionId} (follow it: ./mf thread tail ${threadId} --until-idle)`,
    );
    return terminal.exitCode;
  },
};
