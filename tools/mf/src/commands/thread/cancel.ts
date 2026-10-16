import { apiThreadCancelPath, cancelTurnResponseSchema } from "@meridian/contracts/protocol";
import { EXIT, usageError } from "../../core/cli-error";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { terminalResult } from "./result";

export const threadCancelCommand: CommandSpec = {
  path: ["thread", "cancel"],
  summary: "Cancel one turn (a handoff brief's Stop; the chat's Stop is `thread stop`)",
  args: "<thread>",
  route: "POST /api/threads/:threadId/turns/:turnId/cancel",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Turn id (required)" },
  },
  examples: ["./mf thread cancel <id> --turn <turnId>"],
  async run(ctx) {
    const turnId = stringOption(ctx, "turn");
    if (!turnId) throw usageError("--turn is required (use `thread stop` for the chat's Stop)");
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const response = await session.request(
      "POST",
      apiThreadCancelPath(threadId, turnId),
      undefined,
      { parse: cancelTurnResponseSchema.safeParse },
    );
    const terminal = terminalResult(
      "thread.cancel",
      {
        outcome: response.status === "not_found" ? "failed" : "complete",
        reason: null,
      },
      response,
    );
    ctx.out.result(terminal.result, (value) => `${value.turnId} ${value.status}`);
    return response.status === "not_found" ? EXIT.notFound : terminal.exitCode;
  },
};
