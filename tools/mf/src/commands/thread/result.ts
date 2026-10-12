/** Terminal claims and deadline reports, independent of the interim follow predicates. */
import { apiThreadSnapshotPath, type ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { EXIT, type ExitCode } from "../../core/cli-error";
import type { Output } from "../../core/output";
import type { Session } from "../../core/session";

export type Outcome = "complete" | "failed" | "cancelled" | "interrupt" | "timeout" | "unproven";
export type Reason =
  | "owed"
  | "running"
  | "admission_unknown"
  | "replay_truncated"
  | "unconfirmed"
  | "deliverer_unknown"
  | "snapshot_disagrees";
export type Claim =
  | { outcome: "complete" | "failed" | "cancelled" | "interrupt"; reason: null }
  | { outcome: "unproven" | "timeout"; reason: Reason };
export type Result = Claim & {
  type: "result";
  command: string;
  threadId: string | null;
  turnId?: string | null;
  finalText?: string | null;
  next?: string[];
};
export type TerminalResult<T extends Record<string, unknown> = Record<string, unknown>> = {
  result: Result & T;
  exitCode: ExitCode;
};
const EXITS: Record<Outcome, ExitCode> = {
  complete: EXIT.ok,
  failed: EXIT.failed,
  cancelled: EXIT.cancelled,
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
  const proof: Claim =
    claim.reason === null
      ? { outcome: claim.outcome, reason: null }
      : { outcome: claim.outcome, reason: claim.reason };
  return {
    result: { ...fields, ...proof, type: "result", command },
    exitCode: EXITS[claim.outcome],
  };
}

export function finishResult(out: Output, terminal: TerminalResult): ExitCode {
  const { result } = terminal;
  out.record(result, null, "err");
  if ((result.outcome === "complete" || result.outcome === "failed") && result.finalText)
    out.text(result.finalText.trim());
  const running = result.stillRunning as { turnId: string; status: string } | null | undefined;
  out.note(
    running && result.outcome === "timeout"
      ? `timeout: turn ${running.turnId} still ${running.status} on the server (stop it with ./mf thread cancel ${result.threadId} --turn ${running.turnId})`
      : `${result.outcome} ${result.turnId ?? "?"}${result.reason ? ` ${result.reason}` : ""}`,
  );
  for (const next of result.next ?? []) out.note(next);
  if (result.pendingUnavailable)
    out.note("Snapshot does not carry a pending inbox; owed messages are unknown.");
  return terminal.exitCode;
}

export async function timeoutReport(session: Session, threadId: string) {
  const snapshot = await session.request<ThreadSnapshotResponse>(
    "GET",
    apiThreadSnapshotPath(threadId),
  );
  const turnId = snapshot.liveState.runningTurnId;
  const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
  const stillRunning = turnId ? { turnId, status: turn?.status ?? "unknown" } : null;
  const pending = snapshot.liveState.pending;
  return {
    reason: stillRunning ? ("running" as const) : ("owed" as const),
    stillRunning,
    ...(pending
      ? {
          owed: pending.items.filter(
            (item) => item.intent === "message" && item.provenance.kind === "writer",
          ),
        }
      : { pendingUnavailable: true }),
    next: [
      ...(stillRunning
        ? [`./mf thread cancel ${threadId} --turn ${stillRunning.turnId}`]
        : [`./mf log --thread ${threadId} --level error`]),
      `./mf thread tail ${threadId} --until-idle`,
    ],
  };
}
