import { usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  requirePositional,
  stringOption,
} from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { followThread } from "./stream";

export const threadEventsCommand: CommandSpec = {
  path: ["thread", "events"],
  summary: "Replay the thread's journaled events (no live follow)",
  args: "<thread>",
  route: "WS /api/threads/ws subscribe {lastSeq} catch-up",
  options: {
    ...THREAD_TARGET_OPTIONS,
    since: { type: "string", description: "Replay strictly after this seq (default 0)" },
    full: { type: "boolean", description: "Do not truncate tool payloads" },
    timeout: { type: "string", description: "Give up after this long (default 15s)" },
  },
  examples: ["./mf thread events <id>", "./mf thread events <id> --since 120 --json"],
  async run(ctx) {
    const since = stringOption(ctx, "since") ?? "0";
    if (!/^\d+$/.test(since)) throw usageError("--since must be a non-negative integer seq");
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const result = await followThread({
      session,
      threadId,
      lastSeq: since,
      deadlineAt: Date.now() + durationOption(ctx, "timeout", 15_000),
      out: ctx.out,
      full: flag(ctx, "full"),
      textStream: "out",
      catchupOnly: true,
    });
    ctx.out.note(
      `(caught up to seq ${result.lastSeq}; ./mf thread tail ${threadId} --since ${result.lastSeq} follows live)`,
    );
    return undefined;
  },
};
