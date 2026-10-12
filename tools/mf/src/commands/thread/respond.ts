/** Interrupt responses are successful only after their resolution is journaled. */
import { CliError, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  readJsonArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import { RunEventMapper } from "./events-map";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { finishResult, type Outcome } from "./result";
import { createThreadClient, subscribeThread } from "./transport";

export const threadRespondCommand: CommandSpec = {
  path: ["thread", "respond"],
  summary: "Answer an interrupt and wait for its journaled resolution (6 if unconfirmed)",
  args: "<thread>",
  route: "WS /api/threads/ws interrupt.respond + journal confirmation",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Turn id that raised the interrupt" },
    interrupt: { type: "string", description: "Interrupt id" },
    value: { type: "string", description: "Answer as JSON (literal, @file, or -)" },
    timeout: { type: "string", description: "Confirmation deadline (default 15s)" },
  },
  examples: [
    `./mf thread respond <id> --turn <turnId> --interrupt <interruptId> --value '{"choice":"a"}'`,
  ],
  async run(ctx) {
    const turnId = stringOption(ctx, "turn");
    const interruptId = stringOption(ctx, "interrupt");
    const rawValue = stringOption(ctx, "value");
    if (!turnId || !interruptId || rawValue === undefined)
      throw usageError("--turn, --interrupt and --value are required");
    const value = readJsonArg(rawValue, "--value");
    const timeoutMs = durationOption(ctx, "timeout", 15_000);
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const transport = createThreadClient(session);
    const subscription = subscribeThread(transport, threadId, "0");
    const mapper = new RunEventMapper();
    let rejection: Error | undefined;
    const offError = transport.onInterruptResponseError(({ threadId: rejectedThreadId, error }) => {
      if (rejectedThreadId !== threadId) return;
      rejection = error;
      subscription.reject(error);
    });
    let outcome: Outcome = "unproven";
    try {
      const deadline = Date.now() + timeoutMs;
      // Replay first, so an already resolved interrupt is itself a valid proof.
      let confirmed = false;
      for (;;) {
        const message = await subscription.next(deadline);
        if (message.type === "event")
          confirmed ||= mapper
            .map(message.event)
            .some(
              (event) => event.type === "interrupt.resolved" && event.interruptId === interruptId,
            );
        if (message.type === "live") break;
      }
      if (confirmed) outcome = "complete";
      else {
        if (!transport.respondInterrupt({ threadId, turnId, interruptId, value }).sent)
          throw new CliError("unavailable", "Thread socket closed before interrupt response");
        for (;;) {
          if (rejection) {
            outcome = "failed";
            break;
          }
          const message = await subscription.next(deadline);
          if (rejection) {
            outcome = "failed";
            break;
          }
          if (
            message.type === "event" &&
            mapper
              .map(message.event)
              .some(
                (event) => event.type === "interrupt.resolved" && event.interruptId === interruptId,
              )
          ) {
            outcome = "complete";
            break;
          }
        }
      }
    } catch (error) {
      if (error instanceof CliError && error.code === "timeout")
        outcome = rejection ? "failed" : "unproven";
      else if (error instanceof CliError && error.code === "protocol") {
        outcome = "failed";
        rejection = error;
      } else throw error;
    } finally {
      offError();
      subscription.unsubscribe();
      transport.disconnect();
    }
    return finishResult(ctx.out, {
      type: "result",
      command: "thread.respond",
      threadId,
      turnId,
      interruptId,
      outcome,
      reason: outcome === "unproven" ? "unconfirmed" : null,
      error: rejection?.message ?? null,
      next: [`./mf thread tail ${threadId} --until-idle`],
    });
  },
};
