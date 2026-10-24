/**
 * reply-draws-nothing: whether a reply (or a compaction) leaves the writer nothing to read. This is the
 * one content test behind "a failed attempt that drew nothing". The view's past-failure rule and the
 * server's forgetting decision both call it, so what the writer sees and what the model forgets agree.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { viewAssistantTurn } from "./assistant-view";

/**
 * True when the reply's items are empty and no delivery turn (a `subagent_update` grouped under it) follows it.
 * An empty reasoning block or an `activity` placeholder draws nothing; text, an image, a card or a visible
 * tool draws something.
 */
export function replyDrawsNothing(reply: Turn, delivered: readonly Turn[]): boolean {
  return viewAssistantTurn(reply).items.length === 0 && delivered.length === 0;
}
