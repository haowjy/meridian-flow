/**
 * Filters turns to only those that should render in the chat column.
 *
 * System turns are model-plumbing (commit echoes, agent-swap seeds); they carry
 * context for the model's next request but are not standalone chat bubbles.
 * Inbox-message turns are machine deliveries, rendered in the preceding
 * assistant's activity rows rather than as standalone chat bubbles.
 *
 * Other system turns with custom blocks remain visible as UI content.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { classifyTurn } from "./transcript-model";

export function isVisibleChatTurn(turn: Turn): boolean {
  return classifyTurn(turn) === "bubble";
}

export function filterVisibleTurns(turns: Turn[]): Turn[] {
  return turns.filter(isVisibleChatTurn);
}
