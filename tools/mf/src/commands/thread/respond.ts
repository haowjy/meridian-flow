import { CliError, usageError } from "../../core/cli-error";
import { type CommandSpec, readJsonArg, requirePositional, stringOption } from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { createThreadClient, subscribeThread } from "./transport";

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
    const transport = createThreadClient(session);
    const subscription = subscribeThread(transport, threadId, "0");
    let rejection: Error | undefined;
    const offError = transport.onInterruptResponseError(({ error }) => {
      rejection = error;
    });
    try {
      const connectionDeadline = Date.now() + 10_000;
      while ((await subscription.next(connectionDeadline)).type !== "live") {}
      const receipt = transport.respondInterrupt({ threadId, turnId, interruptId, value });
      if (!receipt.sent)
        throw new CliError("unavailable", "Thread socket closed before interrupt response");
      // Preserve the CLI's existing short rejection window (confirmation is a later lane).
      const deadline = Date.now() + 1_500;
      for (;;) {
        try {
          await subscription.next(deadline);
        } catch (error) {
          if (error instanceof CliError && error.code === "timeout") break;
          if (error instanceof CliError && error.code === "protocol") {
            throw new CliError("http_error", `Interrupt response rejected: ${error.message}`, {
              details: error.details,
            });
          }
          throw error;
        }
      }
      if (rejection)
        throw new CliError("http_error", `Interrupt response rejected: ${rejection.message}`);
    } finally {
      offError();
      subscription.unsubscribe();
      transport.disconnect();
    }
    ctx.out.result(
      { threadId, turnId, interruptId, status: "sent" },
      () => `sent (./mf thread tail ${threadId} --until-idle to watch the run resume)`,
    );
    return undefined;
  },
};
