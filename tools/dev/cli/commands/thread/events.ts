import { usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  requirePositional,
  stringOption,
} from "../../core/command";
import { ACTIVITY_EVENT, applyEventFilter, type EventFilter } from "./event-filter";
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
    name: {
      type: "string",
      description: `Only these events (comma list): dotted types like tool.completed, or custom names like ${ACTIVITY_EVENT}`,
    },
    child: {
      type: "string",
      description:
        "One descendant's activity per frame: status, phase, current tool, target (id, id prefix, or pN)",
    },
    full: { type: "boolean", description: "Do not truncate tool payloads" },
    timeout: { type: "string", description: "Give up after this long (default 15s)" },
  },
  examples: [
    "./mf thread events <id>",
    "./mf thread events <id> --since 120 --json",
    "./mf thread events <id> --name tool.started,tool.completed",
    "./mf thread events <id> --child p2   # one subagent's status and tool over time",
  ],
  async run(ctx) {
    const since = stringOption(ctx, "since") ?? "0";
    if (!/^\d+$/.test(since)) throw usageError("--since must be a non-negative integer seq");
    const names = stringOption(ctx, "name")
      ?.split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const child = stringOption(ctx, "child")?.trim();
    if (names?.length === 0) throw usageError("--name needs at least one event name");
    if (child && names && !names.includes(ACTIVITY_EVENT)) {
      throw usageError(`--child reads ${ACTIVITY_EVENT} frames; drop --name or include that name`);
    }
    const filter: EventFilter = { names: names ?? null, child: child || null };
    const full = flag(ctx, "full");
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
      full,
      textStream: "out",
      ...(filter.names || filter.child
        ? { present: (event) => applyEventFilter(event, filter, full) }
        : {}),
      catchupOnly: true,
    });
    ctx.out.note(
      `(caught up to seq ${result.lastSeq}; ./mf thread tail ${threadId} --since ${result.lastSeq} follows live)`,
    );
    return undefined;
  },
};
