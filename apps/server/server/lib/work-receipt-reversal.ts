/** Executes durable Work receipt inverses through the thread reversal seam. */

import type { ReversalOutcome, WorkReversalResult } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import {
  restoreWork,
  type WorkContextUpdates,
  type WorkRepository,
} from "../domains/projects/index.js";
import type { BlockRepository, TurnRepository } from "../domains/threads/index.js";

type WorkReceiptReversalDeps = {
  blocks: Pick<BlockRepository, "listByTurn">;
  turns: Pick<TurnRepository, "findById">;
  works: WorkRepository;
  contextUpdates: Pick<WorkContextUpdates, "projectChanged">;
};

export type WorkReceiptReversal = WorkReversalResult & { workId: WorkId };

export function combineWorkReversalOutcome(
  outcome: ReversalOutcome,
  workReceipts: WorkReceiptReversal[],
): ReversalOutcome {
  if (workReceipts.length === 0) return outcome;
  return {
    ...outcome,
    status: outcome.status === "nothing_to_undo" ? "reversed" : outcome.status,
    workReceipts,
  };
}

export async function reverseWorkReceipts(
  deps: WorkReceiptReversalDeps,
  input: { threadId: ThreadId; turnId: TurnId; direction: "undo" | "redo" },
): Promise<WorkReceiptReversal[]> {
  if (input.direction !== "undo") return [];
  const turn = await deps.turns.findById(input.turnId);
  if (!turn || turn.threadId !== input.threadId) return [];

  const results: WorkReceiptReversal[] = [];
  for (const block of await deps.blocks.listByTurn(input.turnId)) {
    const inverse = restoreInverse(block.content);
    if (!inverse) continue;
    const work = await restoreWork(
      { works: deps.works, contextUpdates: deps.contextUpdates },
      inverse.workId,
    );
    results.push({ ...inverse, name: work.name, status: "restored" });
  }
  return results;
}

export async function getWorkReceiptReversalAvailability(
  deps: Pick<WorkReceiptReversalDeps, "blocks" | "turns" | "works">,
  input: { threadId: ThreadId; turnId: TurnId },
): Promise<{ undo: boolean; redo: false }> {
  const turn = await deps.turns.findById(input.turnId);
  if (!turn || turn.threadId !== input.threadId) return { undo: false, redo: false };

  for (const block of await deps.blocks.listByTurn(input.turnId)) {
    const inverse = restoreInverse(block.content);
    if (!inverse) continue;
    const work = await deps.works.findById(inverse.workId);
    if (work?.deletedAt) return { undo: true, redo: false };
  }
  return { undo: false, redo: false };
}

function restoreInverse(content: JsonValue | null): { command: "restore"; workId: WorkId } | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const metadata = content.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const receipt = metadata.workReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const inverse = receipt.inverse;
  if (!inverse || typeof inverse !== "object" || Array.isArray(inverse)) return null;
  return inverse.command === "restore" && typeof inverse.workId === "string"
    ? { command: "restore", workId: inverse.workId as WorkId }
    : null;
}
