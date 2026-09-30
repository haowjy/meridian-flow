import { usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  requirePositional,
  stringOption,
} from "../../core/command";
import { presentChild } from "./child-activity";
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
    child: {
      type: "string",
      description:
        "One child's activity per frame: status, phase, current tool, target (id, id prefix, or pN)",
    },
    full: { type: "boolean", description: "Do not truncate tool payloads" },
    timeout: { type: "string", description: "Give up after this long (default 15s)" },
  },
  examples: [
    "./mf thread events <id>",
    "./mf thread events <id> --since 120 --json",
    "./mf thread events <id> --child p2   # one subagent's status and tool over time",
  ],
  async run(ctx) {
    const since = stringOption(ctx, "since") ?? "0";
    if (!/^\d+$/.test(since)) throw usageError("--since must be a non-negative integer seq");
    const child = stringOption(ctx, "child")?.trim();
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
      ...(child ? { present: presentChild(child) } : {}),
      catchupOnly: true,
    });
    ctx.out.note(
      `(caught up to seq ${result.lastSeq}; ./mf thread tail ${threadId} --since ${result.lastSeq} follows live)`,
    );
    return undefined;
  },
};
