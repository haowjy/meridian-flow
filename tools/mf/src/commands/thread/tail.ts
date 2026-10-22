import {
  apiThreadSnapshotPath,
  type ThreadLiveState,
  type ThreadSnapshotResponse,
  threadSnapshotSchema,
} from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import { CliError, usageError } from "../../core/cli-error";
import {
  type CommandContext,
  type CommandSpec,
  durationOption,
  flag,
  requirePositional,
  stringOption,
} from "../../core/command";
import type { Session } from "../../core/session";
import { jsonResponse } from "../../core/session";
import { createObserver, type Observer } from "./observe";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { type Claim, classifyDeadline, finishResult, terminalResult } from "./result";
import { recordIsIdle, runStateOfEvent } from "./run-state";
import { followThread } from "./stream";

const STATUS_EVENT = "meridian.thread.status";

export const threadTailCommand: CommandSpec = {
  path: ["thread", "tail"],
  summary: "Follow live events (catch-up first)",
  args: "<thread>",
  route: "WS /api/threads/ws subscribe",
  options: {
    ...THREAD_TARGET_OPTIONS,
    since: {
      type: "string",
      description: "Replay strictly after this seq (default: live only; not with --until-idle)",
    },
    "until-idle": {
      type: "boolean",
      description:
        "Follow through the app's thread sync until a read shows no open execution or awake lease and no pending writer message (already idle returns after the first read)",
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
    const untilIdle = flag(ctx, "until-idle");
    const since = stringOption(ctx, "since");
    if (since !== undefined && !/^\d+$/.test(since)) throw usageError("--since must be a seq");
    if (untilIdle && since !== undefined)
      throw usageError(
        "--since does not apply with --until-idle: the follow joins from its own first read (use ./mf thread events --since to replay)",
      );
    const deadlineAt = Date.now() + durationOption(ctx, "timeout", 10 * 60_000);
    if (untilIdle) return untilIdleTail(session, ctx, threadId, deadlineAt);
    try {
      const lastSeq =
        since ??
        (
          await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
            timeoutMs: deadlineAt - Date.now(),
            decode: jsonResponse(threadSnapshotSchema),
          })
        ).liveState.resumeAfterSeq;
      await followThread({
        session,
        threadId,
        lastSeq,
        deadlineAt,
        out: ctx.out,
        full: flag(ctx, "full"),
        textStream: "out",
      });
    } catch (error) {
      // A bounded tail that simply ran out of time is a normal stop, not a failure.
      if (error instanceof CliError && error.code === "timeout") return undefined;
      throw error;
    }
    return undefined;
  },
};

/** Confirms the chat idle from an applied read, through the shared `ThreadSync` (`observe.ts`). */
async function untilIdleTail(
  session: Session,
  ctx: CommandContext,
  threadId: string,
  deadlineAt: number,
) {
  const CATCH_UP_MS = 1500;
  type Proof = {
    read: ThreadSnapshotResponse;
    claimed: string[];
    outcome: ReturnType<typeof tailResult>;
    immediate: boolean;
  };
  let proof: Proof | null = null;
  let join: ThreadSnapshotResponse | null = null;
  const observer: Observer = createObserver({
    session,
    threadId,
    out: ctx.out,
    full: flag(ctx, "full"),
    textStream: "out",
    deadlineAt,
    onFrame(event) {
      // A turn event only precedes the closing record in the same commit; the record and the
      // status frame are what can show the chat idle.
      if (event.type !== "event") return;
      if (event.name === STATUS_EVENT) return observer.refresh();
      const record = runStateOfEvent(event);
      if (record !== null && recordIsIdle({ runState: record })) observer.refresh();
    },
    onLive: (state) => {
      if (recordIsIdle(state)) observer.refresh();
    },
    onRead(read) {
      join ??= read;
      if (proof !== null || !isIdle(read.liveState)) return;
      const immediate = join === read;
      // Read membership does not depend on replay arriving before the diagnostic deadline.
      const initial = new Map(join.turns.map((turn) => [turn.id, turn]));
      const claimed = immediate
        ? []
        : [
            ...new Set([
              ...[...initial.values()]
                .filter((turn) => turn.role === "assistant" && !isTerminalTurnStatus(turn.status))
                .map((turn) => turn.id),
              ...read.turns
                .filter((turn) => turn.role === "assistant" && !initial.has(turn.id))
                .map((turn) => turn.id),
              ...[...observer.turnIds].filter(
                (id) => read.turns.find((turn) => turn.id === id)?.role !== "user",
              ),
            ]),
          ];
      proof = {
        read,
        claimed,
        immediate,
        outcome: tailResult(threadId, read, new Set(claimed), {
          failed: observer.failed,
          truncated: observer.truncated,
        }),
      };
    },
  });
  try {
    observer.start();
    await observer.until(() => proof !== null, deadlineAt);
    const frozen = proof as Proof | null;
    if (!frozen) throw new Error("Tail finished without a confirming snapshot");
    const { read: proving, claimed, outcome, immediate } = frozen;
    const turns = new Map(proving.turns.map((turn) => [turn.id, turn]));
    let observationIncomplete = false;
    if (!immediate) {
      try {
        await observer.until(
          () => observer.pending(claimed, turns).length === 0,
          Math.min(deadlineAt, Date.now() + CATCH_UP_MS),
        );
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        observationIncomplete = true;
      }
    }
    return finishResult(
      ctx.out,
      {
        ...outcome,
        result: {
          ...outcome.result,
          ...(observationIncomplete ? { observationIncomplete: true } : {}),
          ...(immediate ? {} : observer.liveView(claimed)),
        },
      },
      { full: flag(ctx, "full") },
    );
  } catch (error) {
    if (error instanceof CliError && error.code === "timeout") {
      const last = observer.lastRead;
      const { reason, ...report } = classifyDeadline(last, threadId);
      return finishResult(
        ctx.out,
        terminalResult(
          "thread.tail",
          { outcome: "timeout", reason },
          {
            threadId,
            turns: [...observer.turnIds],
            ...report,
            ...(last ? { snapshotStale: true } : { snapshotUnavailable: true }),
          },
        ),
      );
    }
    throw error;
  } finally {
    observer.close();
  }
}

/** Asleep, with no open execution and no writer message in the record (`isBusy` on a view with no intents). */
function isIdle(state: ThreadLiveState): boolean {
  return state.status.kind === "asleep" && recordIsIdle(state);
}

/** Known terminal outcomes survive gaps; missing replay cannot prove completion. */
function tailResult(
  threadId: string,
  snapshot: ThreadSnapshotResponse,
  ids: ReadonlySet<string>,
  observed: { failed: boolean; truncated: boolean } = {
    failed: false,
    truncated: false,
  },
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
