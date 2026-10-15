/** A reply's text as the writer reads it: the view model's visible text items, in order. */
import type { Turn } from "@meridian/contracts/threads";
import { viewTranscript } from "@meridian/thread-client";

/**
 * The text items of `turnId`'s reply joined in order, or null when it shows none. `turns` are
 * the whole thread's turns so the view model decides visibility the way the app does.
 */
export function replyText(turns: Turn[], turnId: string | null): string | null {
  if (!turnId) return null;
  const view = viewTranscript({ turns, activity: { awaitingSubagents: false } });
  const items = view.items.get(turnId)?.items ?? [];
  const text = items.map((item) => (item.kind === "text" ? item.text : "")).join("");
  return text || null;
}
