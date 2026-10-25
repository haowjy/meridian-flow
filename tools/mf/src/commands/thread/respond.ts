/** Answer one durable ask by id through the shared authenticated thread socket. */

import { randomUUID } from "node:crypto";
import { CliError, EXIT, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  readValueArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { createThreadClient } from "./transport";

export const threadRespondCommand: CommandSpec = {
  path: ["thread", "respond"],
  summary: "Answer or skip a durable ask by ask id",
  args: "<thread>",
  route: "WS /api/threads/ws ask.answer",
  options: {
    ...THREAD_TARGET_OPTIONS,
    ask: { type: "string", description: "Ask id (required)" },
    option: { type: "string", description: "Choose an offered option label" },
    text: { type: "string", description: "Answer in your own words (literal, @file, or -)" },
    skip: { type: "boolean", description: "Skip the question" },
    timeout: { type: "string", description: "Reply deadline (default 15s)" },
  },
  examples: [
    "./mf thread respond c3 --ask <askId> --option 'Use first person'",
    "./mf thread respond c3 --ask <askId> --text 'Try both in separate scenes'",
    "./mf thread respond c3 --ask <askId> --skip",
  ],
  async run(ctx) {
    const askId = stringOption(ctx, "ask");
    if (!askId) throw usageError("--ask is required");
    const option = stringOption(ctx, "option");
    const text = stringOption(ctx, "text");
    const skip = flag(ctx, "skip");
    if ([option !== undefined, text !== undefined, skip].filter(Boolean).length !== 1)
      throw usageError("Use exactly one of --option, --text, or --skip");
    const answer = option
      ? ({ kind: "option", label: option } as const)
      : text !== undefined
        ? ({ kind: "text", text: readValueArg(text) } as const)
        : ({ kind: "skip" } as const);
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const client = createThreadClient(session);
    const timeoutMs = durationOption(ctx, "timeout", 15_000);
    try {
      const reply = await Promise.race([
        client.answerAsk({
          threadId,
          askId,
          submissionId: randomUUID(),
          answer,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new CliError("timeout", "Timed out waiting for the ask answer")),
            timeoutMs,
          ),
        ),
      ]);
      ctx.out.result(reply, (value) =>
        value.type === "ask.answer.ok"
          ? `${value.ask.id} ${value.ask.status}`
          : `${value.code}${value.ask ? ` ${value.ask.status}` : ""}`,
      );
      return reply.type === "ask.answer.ok" ? undefined : EXIT.failed;
    } finally {
      client.disconnect();
    }
  },
};
