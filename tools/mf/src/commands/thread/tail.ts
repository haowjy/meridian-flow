import { apiThreadSnapshotPath, type ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  requirePositional,
  stringOption,
} from "../../core/command";
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
      description: "Wait for the next turn.finished or turn.failed event (not confirmed chat idle)",
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
    if (since === undefined) {
      const snapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
      );
      since = snapshot.liveState.resumeAfterSeq;
    }
    const untilIdle = flag(ctx, "until-idle");
    try {
      const result = await followThread({
        session,
        threadId,
        lastSeq: since,
        deadlineAt: Date.now() + durationOption(ctx, "timeout", 10 * 60_000),
        out: ctx.out,
        full: flag(ctx, "full"),
        textStream: "out",
        shouldStop: (event) =>
          untilIdle && (event.type === "turn.finished" || event.type === "turn.failed"),
      });
      if (!untilIdle) return undefined;
      const turnId =
        result.stoppedBy && "turnId" in result.stoppedBy ? result.stoppedBy.turnId : null;
      const snapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
      );
      const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
      return finishResult(
        ctx.out,
        terminalResult(
          "thread.tail",
          {
            outcome:
              result.stoppedBy?.type === "turn.failed"
                ? "failed"
                : turn?.status === "cancelled"
                  ? "cancelled"
                  : "complete",
            reason: null,
          },
          { threadId, turnId },
        ),
      );
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
