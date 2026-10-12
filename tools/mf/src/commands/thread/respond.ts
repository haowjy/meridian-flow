import { CliError, usageError } from "../../core/cli-error";
import { type CommandSpec, readJsonArg, requirePositional, stringOption } from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { openThreadSocket } from "./socket";

export const threadRespondCommand: CommandSpec = {
  path: ["thread", "respond"],
  summary: "Answer a pending interrupt",
  args: "<thread>",
  route: "WS /api/threads/ws interrupt.respond",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Turn id that raised the interrupt" },
    interrupt: { type: "string", description: "Interrupt id" },
    value: { type: "string", description: "Answer as JSON (literal, @file, or -)" },
  },
  examples: [
    `./mf thread respond <id> --turn <turnId> --interrupt <interruptId> --value '{"choice":"a"}'`,
  ],
  async run(ctx) {
    const turnId = stringOption(ctx, "turn");
    const interruptId = stringOption(ctx, "interrupt");
    const rawValue = stringOption(ctx, "value");
    if (!turnId || !interruptId || rawValue === undefined) {
      throw usageError("--turn, --interrupt and --value are required");
    }
    const value = readJsonArg(rawValue, "--value");
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const socket = await openThreadSocket(session);
    try {
      socket.send({ type: "interrupt.respond", threadId, turnId, interruptId, value });
      // The socket reports failures as error frames; give it a moment to object.
      const deadline = Date.now() + 1_500;
      for (;;) {
        const message = await socket.next(deadline).catch((error: unknown) => {
          if (error instanceof CliError && error.code === "timeout") return null;
          throw error;
        });
        if (!message) break;
        if (message.type === "error") {
          throw new CliError(
            "http_error",
            `Interrupt response rejected: ${message.error.message}`,
            {
              details: message.error,
            },
          );
        }
      }
    } finally {
      socket.close();
    }
    ctx.out.result(
      { threadId, turnId, interruptId, status: "sent" },
      () => `sent (./mf thread tail ${threadId} --until-idle to watch the run resume)`,
    );
    return undefined;
  },
};
