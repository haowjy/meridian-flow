/** Executes durable Work receipt inverses through the thread reversal seam. */
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

export type WorkReceiptReversal = {
  command: "restore";
  workId: WorkId;
  status: "restored";
};

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
    await restoreWork({ works: deps.works, contextUpdates: deps.contextUpdates }, inverse.workId);
    results.push({ ...inverse, status: "restored" });
  }
  return results;
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
