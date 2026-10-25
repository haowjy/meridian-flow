/**
 * `thread answer`: answer the chat's open question as the composer takeover does, through the
 * shared answer command over the socket. The ask defaults to the one the takeover would show.
 */
import { apiThreadSnapshotPath, threadSnapshotSchema } from "@meridian/contracts/protocol";
import type { AskAnswer } from "@meridian/contracts/threads";
import {
  answerAsk,
  type ChatAsks,
  EMPTY_CHAT_ASKS,
  openAsk,
  receiveAsks,
} from "@meridian/thread-client";
import { CliError, EXIT, usageError } from "../../core/cli-error";
import { type CommandSpec, flag, requirePositional, stringOption } from "../../core/command";
import { jsonResponse } from "../../core/session";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { createThreadClient } from "./transport";

const CONNECT_TIMEOUT_MS = 10_000;

export const threadAnswerCommand: CommandSpec = {
  path: ["thread", "answer"],
  summary: "Answer the chat's open question: an option, your own words, or skip",
  args: "<thread>",
  route: "WS /api/threads/ws ask.answer",
  options: {
    ...THREAD_TARGET_OPTIONS,
    ask: { type: "string", description: "Ask id (default: the chat's open ask)" },
    option: { type: "string", description: "Answer with this option label" },
    text: { type: "string", description: "Answer in your own words" },
    skip: { type: "boolean", description: "Skip the question" },
  },
  examples: [
    "./mf thread answer <id> --option 'Chapter one'",
    "./mf thread answer <id> --text 'Start with the duel'",
    "./mf thread answer <id> --skip --json",
  ],
  async run(ctx) {
    const option = stringOption(ctx, "option");
    const text = stringOption(ctx, "text");
    const skip = flag(ctx, "skip");
    if ([option !== undefined, text !== undefined, skip].filter(Boolean).length !== 1)
      throw usageError("Pass exactly one of --option, --text or --skip");
    const answer: AskAnswer =
      option !== undefined
        ? { kind: "option", label: option }
        : text !== undefined
          ? { kind: "text", text }
          : { kind: "skip" };

    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const snapshot = await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
      decode: jsonResponse(threadSnapshotSchema),
    });
    let asks: ChatAsks = receiveAsks(EMPTY_CHAT_ASKS, snapshot.asks);
    const askId = stringOption(ctx, "ask") ?? openAsk(asks, snapshot.turns)?.ask.id;
    if (!askId) {
      ctx.out.result(
        { type: "thread.answer", outcome: "failed", reason: "no_open_ask" },
        () => "No open question in this chat",
      );
      return EXIT.notFound;
    }

    const transport = createThreadClient(session);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new CliError("timeout", "Timed out connecting the thread socket")),
          CONNECT_TIMEOUT_MS,
        );
        const stop = transport.onConnectionState((state) => {
          if (state.kind !== "connected") return;
          clearTimeout(timer);
          queueMicrotask(() => stop());
          resolve();
        });
        transport.connect();
      });
      const result = await answerAsk(
        {
          transport,
          update: (change) => {
            asks = change(asks);
          },
          refresh: () => {},
          newSubmissionId: () => globalThis.crypto.randomUUID(),
        },
        threadId,
        askId,
        answer,
      );
      const ask = asks.byId.get(askId) ?? null;
      ctx.out.result(
        {
          type: "thread.answer",
          outcome: result,
          askId,
          status: ask?.status ?? null,
          resolution: ask?.resolution ?? null,
        },
        (value) =>
          `${value.askId} ${value.outcome}${value.resolution ? ` ${JSON.stringify(value.resolution)}` : ""}`,
      );
      return result === "answered"
        ? EXIT.ok
        : result === "not_open"
          ? EXIT.notFound
          : EXIT.unproven;
    } finally {
      transport.disconnect();
    }
  },
};
