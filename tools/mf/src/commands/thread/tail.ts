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

import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { type Claim, finishResult, snapshotActivity, terminalResult } from "./result";
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
    let lastSnapshot: ThreadSnapshotResponse | null = null;
    const readSnapshot = async () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new CliError("timeout", "Tail deadline reached");
      lastSnapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
        undefined,
        { timeoutMs: remaining },
      );
      return lastSnapshot;
    };
    const turnIds = new Set<string>();
    try {
      const initial = since === undefined || untilIdle ? await readSnapshot() : null;
      since ??= initial?.liveState.resumeAfterSeq ?? "0";
      if (initial?.liveState.runningTurnId) turnIds.add(initial.liveState.runningTurnId);
      if (untilIdle && initial && isIdle(initial.liveState))
        return finishResult(ctx.out, tailResult(threadId, initial, new Set()));
      for (;;) {
        const result = await followThread({
          session,
          drainCheckpoint: untilIdle,
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
        for (const id of result.turnIds) turnIds.add(id);
        const snapshot = await readSnapshot();
        if (!isIdle(snapshot.liveState)) continue;
        return finishResult(ctx.out, tailResult(threadId, snapshot, turnIds));
      }
    } catch (error) {
      // A bounded tail that simply ran out of time is a normal stop, not a failure.
      if (error instanceof CliError && error.code === "timeout" && !untilIdle) return undefined;
      if (error instanceof CliError && error.code === "timeout") {
        const activity = lastSnapshot ? snapshotActivity(lastSnapshot) : null;
        return finishResult(
          ctx.out,
          terminalResult(
            "thread.tail",
            {
              outcome: "timeout",
              reason: activity ? (activity.stillRunning ? "running" : "owed") : "unconfirmed",
            },
            {
              threadId,
              turns: [...turnIds],
              ...(activity ? { ...activity, snapshotStale: true } : { snapshotUnavailable: true }),
              next: [`./mf thread tail ${threadId} --until-idle`],
            },
          ),
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

/** Snapshot statuses, not the absence of an error frame, prove the covered outcome. */
function tailResult(threadId: string, snapshot: ThreadSnapshotResponse, ids: ReadonlySet<string>) {
  const turns = [...ids].map((turnId) => ({
    turnId,
    status: snapshot.turns.find((turn) => turn.id === turnId)?.status ?? "missing",
  }));
  let claim: Claim;
  if (turns.some((turn) => !["complete", "error", "cancelled"].includes(turn.status)))
    claim = { outcome: "unproven", reason: "unconfirmed" };
  else if (turns.some((turn) => turn.status === "error"))
    claim = { outcome: "failed", reason: null };
  else if (turns.some((turn) => turn.status === "cancelled"))
    claim = { outcome: "cancelled", reason: null };
  else claim = { outcome: "complete", reason: null };
  return terminalResult("thread.tail", claim, { threadId, turnId: [...ids].at(-1) ?? null, turns });
}
