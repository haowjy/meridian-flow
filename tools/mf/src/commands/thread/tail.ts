import {
  apiThreadSnapshotPath,
  type ThreadLiveState,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  requirePositional,
  stringOption,
} from "../../core/command";
import type { CliEvent } from "./events-map";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { finishResult, terminalResult, timeoutReport } from "./result";
import { followThread } from "./stream";

export const threadTailCommand: CommandSpec = {
  path: ["thread", "tail"],
  summary: "Follow live events (catch-up first)",
  args: "<thread>",
  route: "WS /api/threads/ws subscribe",
  options: {
    ...THREAD_TARGET_OPTIONS,
    since: { type: "string", description: "Replay strictly after this seq (default: live only)" },
    "until-idle": {
      type: "boolean",
      description:
        "Confirm no running turn or awake lease and no pending writer message (already idle returns immediately)",
    },
    timeout: { type: "string", description: "Stop after this long (default 10m)" },
    full: { type: "boolean", description: "Do not truncate tool payloads" },
  },
  examples: ["./mf thread tail <id>", "./mf thread tail <id> --until-idle --json"],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    let since = stringOption(ctx, "since");
    if (since !== undefined && !/^\d+$/.test(since)) throw usageError("--since must be a seq");
    const untilIdle = flag(ctx, "until-idle");
    const deadlineAt = Date.now() + durationOption(ctx, "timeout", 10 * 60_000);
    const readSnapshot = () =>
      session.request<ThreadSnapshotResponse>("GET", apiThreadSnapshotPath(threadId));
    const initial = since === undefined || untilIdle ? await readSnapshot() : null;
    since ??= initial?.liveState.resumeAfterSeq ?? "0";
    if (untilIdle && initial && isIdle(initial.liveState))
      return finishResult(
        ctx.out,
        terminalResult(
          "thread.tail",
          { outcome: "complete", reason: null },
          { threadId, turnId: null },
        ),
      );
    let stoppedBy: CliEvent | null = null;
    try {
      for (;;) {
        const result = await followThread({
          session,
          threadId,
          lastSeq: since,
          deadlineAt,
          out: ctx.out,
          full: flag(ctx, "full"),
          textStream: "out",
          shouldStop: (event) =>
            untilIdle &&
            (event.type === "turn.finished" ||
              event.type === "turn.failed" ||
              (event.type === "event" &&
                ["meridian.thread.status", "meridian.inbox.changed"].includes(event.name))),
          ...(untilIdle ? { shouldStopState: isIdle } : {}),
        });
        since = result.lastSeq;
        if (!untilIdle) return undefined;
        if (result.stoppedBy?.type === "turn.finished" || result.stoppedBy?.type === "turn.failed")
          stoppedBy = result.stoppedBy;
        const snapshot = await readSnapshot();
        if (!isIdle(snapshot.liveState)) continue;
        const turnId = stoppedBy && "turnId" in stoppedBy ? stoppedBy.turnId : null;
        const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
        return finishResult(
          ctx.out,
          terminalResult(
            "thread.tail",
            {
              outcome:
                stoppedBy?.type === "turn.failed"
                  ? "failed"
                  : turn?.status === "cancelled"
                    ? "cancelled"
                    : "complete",
              reason: null,
            },
            { threadId, turnId },
          ),
        );
      }
    } catch (error) {
      // A bounded tail that simply ran out of time is a normal stop, not a failure.
      if (error instanceof CliError && error.code === "timeout" && !untilIdle) return undefined;
      if (error instanceof CliError && error.code === "timeout") {
        const { reason, ...report } = await timeoutReport(session, threadId);
        return finishResult(
          ctx.out,
          terminalResult("thread.tail", { outcome: "timeout", reason }, { threadId, ...report }),
        );
      }
      throw error;
    }
  },
};

function isIdle(state: ThreadLiveState): boolean {
  return (
    state.runningTurnId === null &&
    state.status.kind === "asleep" &&
    !state.pending.items.some(
      (item) => item.intent === "message" && item.provenance.kind === "writer",
    )
  );
}
