/** Metadata-only diagnostics for persisted chat records that miss current contracts. */

import type { EventRecord } from "@meridian/contracts/observability";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { appendTraceEvent } from "../debug/trace/trace-store";

type PersistedContractFailure = {
  contract: "invocation_card" | "subagent_update";
  threadId?: string;
  turnId?: string;
  blockId?: string;
};

const reported = new Set<string>();

export function reportPersistedContractFailure(input: PersistedContractFailure): void {
  if (!DEBUG_FEATURE_ALLOWED) return;
  const key = [input.contract, input.threadId, input.turnId, input.blockId].join("\0");
  if (reported.has(key)) return;
  reported.add(key);
  if (reported.size > 2_000) reported.delete(reported.values().next().value as string);
  const event: EventRecord = {
    timestamp: new Date().toISOString(),
    level: "warn",
    source: "chat.transcript",
    name: "chat.persisted_contract.invalid",
    sensitivity: "safe",
    correlation: {
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
    payload: {
      field: input.contract,
      ...(input.blockId ? { blockId: input.blockId } : {}),
    },
  };
  appendTraceEvent(event);
}
