/** Shared presentation and command policy for durable trail recovery actions. */
import type {
  TrailChangeV1 as TrailChange,
  TrailForwardAction,
  TrailForwardActionResult,
  TrailForwardActionStateV1,
} from "@meridian/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  applyTrailForwardAction,
  bodyFromTrailHashline,
  changeTrailDetailKey,
} from "@/client/change-trails";
import { changeKindLabel } from "@/core/editor/change-mark-labels";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { i18n } from "@/lib/i18n";

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
  action: TrailForwardAction;
  body: string | null;
  canExecute: boolean;
  durableState: TrailForwardActionStateV1 | undefined;
  writerImpact: TrailChange["writerImpact"];
};

export function trailChangeRecovery(change: TrailChange): TrailChangeRecovery {
  const writerImpact = change.writerImpact;
  const action: TrailForwardAction =
    writerImpact?.kind === "resurrection" ? "delete-again" : "restore";
  const durableState = change.forwardActions?.[action];
  const protectedBody =
    writerImpact?.body.status === "available" ? writerImpact.body.markdown : null;
  const body = writerImpact ? protectedBody : bodyFromTrailHashline(change.beforeText);
  const canExecute = protectedBody !== null || durableState?.status === "committed";
  return {
    action,
    body,
    canExecute:
      canExecute && durableState?.status !== "applied" && durableState?.status !== "settled",
    durableState,
    writerImpact,
  };
}

export function trailChangeLabel(change: TrailChange): string {
  if (change.writerImpact?.kind === "resurrection") {
    return i18n._("AI brought back text you deleted");
  }
  if (change.writerImpact?.kind === "sweep") {
    return i18n._("Replaced a passage that included your unsaved edits");
  }
  return changeKindLabel(change.kind);
}

export function useTrailForwardAction(input: {
  threadId: string;
  trailId: string;
  documentId: string;
  change: TrailChange | null;
  runAction?: typeof applyTrailForwardAction;
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
  const canCopy = anchorUnavailable && Boolean(recovery.body);

  async function execute(): Promise<TrailRecoveryOutcome> {
    if (!input.change) return { kind: "failed" };
    if (command.kind === "pending" || applied) return { kind: "applied" };
    setCommand({ kind: "pending" });
    let outcome: TrailRecoveryOutcome;
    try {
      outcome = outcomeFromResult(
        await (input.runAction ?? applyTrailForwardAction)({
          threadId: input.threadId,
          trailId: input.trailId,
          changeId: input.change.changeId,
          action: recovery.action,
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
    canCopy,
    applied,
    anchorUnavailable,
    isPending: command.kind === "pending",
    failed: command.kind === "failed" && !durableTerminal,
    execute,
  };
}

function outcomeFromResult(result: TrailForwardActionResult): TrailRecoveryOutcome {
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
  action: "restore",
  body: null,
  canExecute: false,
  durableState: undefined,
  writerImpact: null,
};
