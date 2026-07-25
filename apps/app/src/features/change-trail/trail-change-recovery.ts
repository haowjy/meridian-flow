/** Shared presentation and command policy for durable trail recovery actions. */
import type {
  TrailChangeV1 as TrailChange,
  TrailRestoreResult,
  TrailRestoreStateV1,
} from "@meridian/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  bodyFromTrailHashline,
  changeTrailDetailKey,
  restoreTrailChange,
} from "@/client/change-trails";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

export type TrailRecoveryOutcome =
  | { kind: "applied" }
  | { kind: "anchor-unavailable" }
  | { kind: "retry-exhausted" }
  | { kind: "failed" };

type RecoveryCommandState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "settling"; outcome: Exclude<TrailRecoveryOutcome, { kind: "failed" }> }
  | { kind: "failed" };

export type TrailChangeRecovery = {
  body: string | null;
  canExecute: boolean;
  durableState: TrailRestoreStateV1 | undefined;
};

export function trailChangeRecovery(change: TrailChange): TrailChangeRecovery {
  const durableState = change.restore;
  const body = bodyFromTrailHashline(change.beforeText);
  const canExecute = body !== null || durableState?.status === "committed";
  return {
    body,
    canExecute:
      canExecute && durableState?.status !== "applied" && durableState?.status !== "settled",
    durableState,
  };
}

export function useTrailRestore(input: {
  threadId: string;
  trailId: string;
  documentId: string;
  change: TrailChange | null;
  runRestore?: typeof restoreTrailChange;
}) {
  const queryClient = useQueryClient();
  const recovery = input.change ? trailChangeRecovery(input.change) : EMPTY_RECOVERY;
  const [command, setCommand] = useState<RecoveryCommandState>({ kind: "idle" });
  const durableApplied = recovery.durableState?.status === "applied";
  const durableUnavailable = recovery.durableState?.status === "settled";
  const durableTerminal = durableApplied || durableUnavailable;
  const applied =
    durableApplied || (command.kind === "settling" && command.outcome.kind === "applied");
  const anchorUnavailable =
    durableUnavailable ||
    (command.kind === "settling" &&
      (command.outcome.kind === "anchor-unavailable" ||
        command.outcome.kind === "retry-exhausted"));
  const canExecute = recovery.canExecute && !applied && !anchorUnavailable;
  async function execute(): Promise<TrailRecoveryOutcome> {
    if (!input.change) return { kind: "failed" };
    if (command.kind === "pending" || applied) return { kind: "applied" };
    setCommand({ kind: "pending" });
    let outcome: TrailRecoveryOutcome;
    try {
      outcome = outcomeFromResult(
        await (input.runRestore ?? restoreTrailChange)({
          threadId: input.threadId,
          trailId: input.trailId,
          changeId: input.change.changeId,
        }),
      );
    } catch {
      outcome = { kind: "failed" };
    }
    if (outcome.kind === "failed") {
      setCommand({ kind: "failed" });
      return outcome;
    }
    setCommand({ kind: "settling", outcome });
    if (outcome.kind === "applied") {
      getDocumentSessionRegistry()
        .peek(input.documentId)
        ?.markerStore.dismiss(input.change.changeId);
    }
    await queryClient.invalidateQueries({
      queryKey: changeTrailDetailKey(input.threadId, input.trailId),
    });
    return outcome;
  }

  return {
    ...recovery,
    canExecute,
    applied,
    anchorUnavailable,
    isPending: command.kind === "pending",
    failed: command.kind === "failed" && !durableTerminal,
    execute,
  };
}

function outcomeFromResult(result: TrailRestoreResult): TrailRecoveryOutcome {
  switch (result.status) {
    case "applied":
    case "already_applied":
      return { kind: "applied" };
    case "anchor_unavailable":
      return { kind: "anchor-unavailable" };
    case "retry_exhausted":
      return { kind: "retry-exhausted" };
  }
}

const EMPTY_RECOVERY: TrailChangeRecovery = {
  body: null,
  canExecute: false,
  durableState: undefined,
};
