import type { Turn } from "@meridian/contracts/protocol";
import { viewAssistantTurn } from "./assistant-view";

export function replyDrawsNothing(reply: Turn, delivered: readonly Turn[]): boolean {
  return viewAssistantTurn(reply).items.length === 0 && delivered.length === 0;
}
