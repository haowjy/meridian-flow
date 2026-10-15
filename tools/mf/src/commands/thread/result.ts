/** Terminal claims and deadline reports, independent of the interim follow predicates. */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { EXIT, type ExitCode } from "../../core/cli-error";
import type { Output } from "../../core/output";
import { type LiveDiff, renderLiveDiff } from "./reduced-thread";
import { currentTurnId, owedWriterMessages } from "./run-state";

export type Outcome =
  | "accepted"
  | "complete"
  | "failed"
  | "cancelled"
  | "handed_back"
  | "interrupt"
  | "timeout"
  | "unproven";
export type Reason =
  | "owed"
  | "running"
  | "lease_awake"
  | "admission_unknown"
  | "replay_truncated"
  | "unconfirmed"
  | "deliverer_unknown"
  | "credits_exhausted";
/** `accepted` is admission only and is built solely by `thread send --no-wait`; no wait produces it. */
export type Claim =
  | { outcome: "accepted" | "complete" | "cancelled" | "handed_back" | "interrupt"; reason: null }
  | { outcome: "failed"; reason: null | "credits_exhausted" }
  | { outcome: "unproven" | "timeout"; reason: Exclude<Reason, "credits_exhausted"> };
export type Result = Claim & {
  type: "result";
  command: string;
  threadId: string | null;
  turnId?: string | null;
  finalText?: string | null;
  next?: string[];
  liveView?: "matches" | "differs";
  liveDiff?: LiveDiff[];
};
export type TerminalResult<T extends Record<string, unknown> = Record<string, unknown>> = {
  result: Result & T;
  exitCode: ExitCode;
};
const EXITS: Record<Outcome, ExitCode> = {
  accepted: EXIT.ok,
  complete: EXIT.ok,
  failed: EXIT.failed,
  cancelled: EXIT.cancelled,
  handed_back: EXIT.cancelled,
  interrupt: EXIT.interrupt,
  timeout: EXIT.timeout,
  unproven: EXIT.unproven,
};
/** One envelope/exit boundary; command fields cannot override the terminal contract. */
export function terminalResult<T extends Record<string, unknown> & { threadId: string | null }>(
  command: string,
  claim: Claim,
  fields: T,
): TerminalResult<T> {
  // Rebuild so callers that pass a whole prior result as the claim leak nothing else.
  const proof: Claim =
    claim.outcome === "failed"
      ? { outcome: "failed", reason: claim.reason }
      : claim.reason === null
        ? { outcome: claim.outcome, reason: null }
        : { outcome: claim.outcome, reason: claim.reason };
  return {
    result: { ...fields, ...proof, type: "result", command },
    exitCode: EXITS[claim.outcome],
  };
}

export function finishResult(
  out: Output,
  terminal: TerminalResult,
  options: { full?: boolean } = {},
): ExitCode {
  const { result } = terminal;
  out.record(result, null, "err");
  if ((result.outcome === "complete" || result.outcome === "failed") && result.finalText)
    out.text(result.finalText.trim());
  const running = result.stillRunning as { turnId: string; status: string } | null | undefined;
  const emptyIdleTail =
    result.command === "thread.tail" &&
    result.outcome === "complete" &&
    result.idle === true &&
    Array.isArray(result.turns) &&
    result.turns.length === 0;
  out.note(
    emptyIdleTail
      ? "complete: chat idle, no turn ran during the wait"
      : result.outcome === "handed_back"
        ? `handed_back ${result.userTurnId} (a Stop returned this message before any reply took it)`
        : running && result.outcome === "timeout"
          ? result.snapshotStale
            ? `timeout: last snapshot showed turn ${running.turnId} ${running.status}; current state is unconfirmed`
            : `timeout: turn ${running.turnId} still ${running.status} on the server (stop it with ./mf thread stop ${result.threadId})`
          : result.outcome === "timeout" && result.reason === "lease_awake"
            ? "timeout: last snapshot showed no running turn or owed message, but the chat was awake; idle is unconfirmed"
            : `${result.outcome} ${result.turnId ?? "?"}${result.reason ? ` ${result.reason}` : ""}`,
  );
  if (result.liveView === "differs" && result.liveDiff)
    out.note(renderLiveDiff(result.liveDiff, options.full ?? false));
  for (const next of result.next ?? []) out.note(next);
  return terminal.exitCode;
}

type UnavailableDeadlineReport = { reason: "unconfirmed"; next: string[] };
type DeadlineReport =
  | UnavailableDeadlineReport
  | (ReturnType<typeof snapshotActivity> & {
      reason: "running" | "owed" | "lease_awake" | "unconfirmed";
      next: string[];
    });

/** Describe the last deadline evidence, never infer a confirmed outcome from it. */
export function classifyDeadline(
  snapshot: ThreadSnapshotResponse | null,
  threadId: string,
): DeadlineReport {
  if (!snapshot) {
    return {
      reason: "unconfirmed",
      next: [`./mf thread tail ${threadId} --until-idle`],
    } satisfies UnavailableDeadlineReport;
  }
  const activity = snapshotActivity(snapshot);
  const reason = activity.stillRunning
    ? ("running" as const)
    : activity.owed.length > 0
      ? ("owed" as const)
      : snapshot.liveState.status.kind === "awake"
        ? ("lease_awake" as const)
        : ("unconfirmed" as const);
  return {
    reason,
    ...activity,
    next: [
      ...(activity.stillRunning ? [`./mf thread stop ${threadId}`] : []),
      `./mf thread tail ${threadId} --until-idle`,
    ],
  };
}

/** Obligations from the mandatory live-state projection, never durable thread.status. */
export function snapshotActivity(snapshot: ThreadSnapshotResponse) {
  const { runState } = snapshot.liveState;
  const turnId = currentTurnId(runState);
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  return {
    stillRunning: turnId ? { turnId, status: turn?.status ?? "unknown" } : null,
    owed: owedWriterMessages(runState),
  };
}
