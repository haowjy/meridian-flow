/** Settle every attempted summary response inside the transaction that ends its placeholder. */
import type { TreeBudget } from "@meridian/contracts/spawn";
import type { Thread } from "@meridian/contracts/threads";
import { CompactionMetadataCodec } from "../../threads/index.js";
import type { SummaryOutcome, SummaryResponse } from "../ports/conversation-summarizer.js";
import { type PersistenceDeps, persistAndAppendEvents } from "./persistence.js";
import type { TurnAccounting } from "./turn-accounting.js";

export async function settleSummaryResponses(input: {
  deps: PersistenceDeps;
  thread: Thread;
  rows: readonly SummaryResponse[];
  summary?: {
    turnId: import("@meridian/contracts/runtime").TurnId;
    summarizer: SummaryOutcome["summarizer"];
  };
  accounting: TurnAccounting;
  treeBudget: TreeBudget;
}): Promise<void> {
  if (input.summary) {
    const turn = await input.deps.repos.turns.findById(input.summary.turnId);
    if (!turn) throw new Error("Summary placeholder disappeared");
    await input.deps.repos.turns.updateStatus(turn.id, {
      status: turn.status,
      metadata: {
        ...CompactionMetadataCodec.parse(turn.metadata),
        summarizer: input.summary.summarizer,
      },
    });
  }
  if (input.rows.length === 0) return;
  await persistAndAppendEvents(input.deps, input.thread.id, async () => {
    const events = [];
    for (const { providerData, ...row } of input.rows) {
      const cost = await input.accounting.computeAndDebit(
        {
          provider: row.provider,
          model: row.model,
          usage: {
            inputTokens: row.inputTokens ?? 0,
            outputTokens: row.outputTokens ?? 0,
            reasoningTokens: row.reasoningTokens ?? undefined,
            cacheReadTokens: row.cacheReadTokens ?? undefined,
            cacheWriteTokens: row.cacheWriteTokens ?? undefined,
          },
          providerData,
        },
        input.thread,
        input.thread.id,
        row.turnId,
        input.treeBudget,
        row.id,
      );
      events.push({
        type: "model.response_received" as const,
        response: {
          ...row,
          costUsd: cost.costUsd,
          millicredits: cost.millicredits,
          priceSource: cost.priceSource,
          pricingSnapshot: cost.pricingSnapshot,
        },
      });
    }
    return { result: undefined, events };
  });
}
