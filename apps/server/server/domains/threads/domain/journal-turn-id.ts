import type { OrchestratorEvent } from "@meridian/contracts/threads";

export function deriveJournalTurnId(event: OrchestratorEvent): string | null {
  if (event.type === "context.compacted") return event.compactionTurnId;
  if (event.type === "turns.forgotten") return event.byTurnId;
  if ("turn" in event) return event.turn.id;
  if ("response" in event) return event.response.turnId;
  if ("block" in event) return event.block.turnId;
  if ("turnId" in event) return event.turnId ?? null;
  return null;
}
