/**
 * `thread answer`: answer the chat's open question as the composer takeover does, through the
 * shared answer command over the socket. The ask defaults to the one the takeover would show.
 */
import { apiThreadSnapshotPath, threadSnapshotSchema } from "@meridian/contracts/protocol";
import {
  type AskAnswer,
  draftAnswersSchema,
  type QuestionAnswer,
} from "@meridian/contracts/threads";
import {
  answerAsk,
  type ChatAsks,
  EMPTY_CHAT_ASKS,
  openAsk,
  receiveAsks,
} from "@meridian/thread-client";
import { EXIT, usageError } from "../../core/cli-error";
import {
  type CommandContext,
  type CommandSpec,
  listOption,
  type OptionSpec,
  readJsonArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import { jsonResponse } from "../../core/session";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { connectThreadClient } from "./transport";

/** The options both `answer` and `presence` take: the answers, one per question in order. */
export const ANSWER_OPTIONS: Record<string, OptionSpec> = {
  answer: {
    type: "string",
    multiple: true,
    description:
      "One question's answer, repeated in question order: option:<label>, text:<words> or skip (presence also takes none)",
  },
  answers: {
    type: "string",
    description:
      "All answers as JSON: [{kind:'option',label}|{kind:'text',text}|{kind:'skipped'}|null, …]",
  },
};

/** The answers from `--answer` (repeated) or `--answers` (JSON); `none` and null are unanswered. */
export function answerArgs(ctx: CommandContext): (QuestionAnswer | null)[] {
  const repeated = listOption(ctx, "answer");
  const json = stringOption(ctx, "answers");
  if (repeated.length > 0 === (json !== undefined))
    throw usageError("Pass --answer once per question, or --answers as JSON");
  if (json !== undefined) return draftAnswersSchema.parse(readJsonArg(json, "--answers"));
  return repeated.map((raw) => {
    if (raw === "skip") return { kind: "skipped" };
    if (raw === "none") return null;
    if (raw.startsWith("option:")) return { kind: "option", label: raw.slice(7) };
    if (raw.startsWith("text:")) return { kind: "text", text: raw.slice(5) };
    throw usageError(`--answer ${raw}: use option:<label>, text:<words> or skip`);
  });
}

export const threadAnswerCommand: CommandSpec = {
  path: ["thread", "answer"],
  summary: "Answer the chat's open question: per question an option, your own words, or skip",
  args: "<thread>",
  route: "WS /api/threads/ws ask.answer",
  options: {
    ...THREAD_TARGET_OPTIONS,
    ask: { type: "string", description: "Ask id (default: the chat's open ask)" },
    ...ANSWER_OPTIONS,
  },
  examples: [
    "./mf thread answer <id> --answer 'option:Chapter one'",
    "./mf thread answer <id> --answer 'option:Left' --answer 'text:Start with the duel' --answer skip",
    './mf thread answer <id> --answers \'[{"kind":"skipped"}]\' --json',
  ],
  async run(ctx) {
    const answers = answerArgs(ctx);
    if (answers.some((answer) => answer === null))
      throw usageError("An answer can't be left out: use skip");
    const answer: AskAnswer = { kind: "answers", answers: answers as QuestionAnswer[] };

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

    const transport = await connectThreadClient(session);
    try {
      const result = await answerAsk(
        {
          transport,
          update: (change) => {
            asks = change(asks);
          },
          refresh: async () => {
            const read = await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
              decode: jsonResponse(threadSnapshotSchema),
            });
            asks = receiveAsks(asks, read.asks);
          },
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
          outcome: result.kind,
          askId,
          status: ask?.status ?? null,
          resolution: ask?.resolution ?? null,
        },
        (value) =>
          `${value.askId} ${value.outcome}${value.resolution ? ` ${JSON.stringify(value.resolution)}` : ""}`,
      );
      return result.kind === "answered"
        ? EXIT.ok
        : result.kind === "not_open"
          ? EXIT.notFound
          : EXIT.unproven;
    } finally {
      transport.disconnect();
    }
  },
};
