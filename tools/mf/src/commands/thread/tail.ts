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
import { type Claim, classifyDeadline, finishResult, terminalResult } from "./result";
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
    let observedFailure = false;
    try {
      const initial = since === undefined || untilIdle ? await readSnapshot() : null;
      since ??= initial?.liveState.resumeAfterSeq ?? "0";
      if (initial?.liveState.runningTurnId) turnIds.add(initial.liveState.runningTurnId);
      if (untilIdle && initial && isIdle(initial.liveState))
        return finishResult(ctx.out, tailResult(threadId, initial, new Set()));
      const result = await followThread({
        session,
        threadId,
        lastSeq: since,
        deadlineAt,
        out: ctx.out,
        full: flag(ctx, "full"),
        textStream: "out",
        shouldStop: (event) => {
          if ("turnId" in event) turnIds.add(event.turnId);
          if (event.type === "turn.failed") observedFailure = true;
          return (
            untilIdle &&
            (event.type === "turn.finished" ||
              event.type === "turn.failed" ||
              (event.type === "event" &&
                ["meridian.thread.status", "meridian.inbox.changed"].includes(event.name)))
          );
        },
        ...(untilIdle
          ? {
              shouldStopState(state) {
                if (state.runningTurnId) turnIds.add(state.runningTurnId);
                return isIdle(state);
              },
              async confirmStop(observed: readonly string[]) {
                for (const id of observed) turnIds.add(id);
                return isIdle((await readSnapshot()).liveState);
              },
            }
          : {}),
      });
      if (!untilIdle) return undefined;
      for (const id of result.turnIds) turnIds.add(id);
      if (!lastSnapshot) throw new Error("Tail finished without a confirming snapshot");
      return finishResult(
        ctx.out,
        tailResult(threadId, lastSnapshot, turnIds, {
          failed: observedFailure,
          truncated: result.truncated,
        }),
      );
    } catch (error) {
      // A bounded tail that simply ran out of time is a normal stop, not a failure.
      if (error instanceof CliError && error.code === "timeout" && !untilIdle) return undefined;
      if (error instanceof CliError && error.code === "timeout") {
        const { reason, ...report } = classifyDeadline(lastSnapshot, threadId);
        return finishResult(
          ctx.out,
          terminalResult(
            "thread.tail",
            { outcome: "timeout", reason },
            {
              threadId,
              turns: [...turnIds],
              ...report,
              ...(lastSnapshot ? { snapshotStale: true } : { snapshotUnavailable: true }),
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

/** Known terminal outcomes survive gaps; missing replay cannot prove completion. */
function tailResult(
  threadId: string,
  snapshot: ThreadSnapshotResponse,
  ids: ReadonlySet<string>,
  observed = { failed: false, truncated: false },
) {
  const turns = [...ids].map((turnId) => ({
    turnId,
    status: snapshot.turns.find((turn) => turn.id === turnId)?.status ?? "missing",
  }));
  let claim: Claim;
  if (observed.failed || turns.some((turn) => turn.status === "error"))
    claim = { outcome: "failed", reason: null };
  else if (turns.some((turn) => turn.status === "cancelled"))
    claim = { outcome: "cancelled", reason: null };
  else if (observed.truncated) claim = { outcome: "unproven", reason: "replay_truncated" };
  else if (turns.some((turn) => !["complete", "error", "cancelled"].includes(turn.status)))
    claim = { outcome: "unproven", reason: "unconfirmed" };
  else claim = { outcome: "complete", reason: null };
  return terminalResult("thread.tail", claim, {
    threadId,
    turnId: [...ids].at(-1) ?? null,
    turns,
    idle: true,
  });
}
