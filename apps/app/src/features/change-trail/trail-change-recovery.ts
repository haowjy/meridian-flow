/** Shared presentation and command policy for durable trail recovery actions. */
import { t } from "@lingui/core/macro";
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
  canRecover: boolean;
  durableState: TrailForwardActionStateV1 | undefined;
  protection: TrailChange["writerProtection"];
};

export function trailChangeRecovery(change: TrailChange): TrailChangeRecovery {
  const protection = protectionFor(change);
  const action: TrailForwardAction =
    protection?.kind === "resurrection" ? "delete-again" : "restore";
  const durableState = change.forwardActions?.[action];
  const protectedBody = protection?.body.status === "available" ? protection.body.markdown : null;
  return {
    action,
    body: protectedBody ?? bodyFromTrailHashline(change.beforeText),
    canRecover: Boolean(protection || change.swept || durableState),
    durableState,
    protection,
  };
}

export function trailChangeLabel(change: TrailChange): string {
  const protection = protectionFor(change);
  if (protection?.kind === "resurrection") return t`↻ AI brought back text you deleted`;
  if (protection?.kind === "sweep") {
    return t`Replaced a passage, including edits the agent hadn't seen yet.`;
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

function protectionFor(change: TrailChange): TrailChange["writerProtection"] {
  if (change.writerProtection) return change.writerProtection;
  return change.swept ? { kind: "sweep", body: change.swept.removed } : undefined;
}

const EMPTY_RECOVERY: TrailChangeRecovery = {
  action: "restore",
  body: null,
  canRecover: false,
  durableState: undefined,
  protection: undefined,
};
