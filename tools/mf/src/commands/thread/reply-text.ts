import type { Turn } from "@meridian/contracts/threads";
import { viewTranscript } from "@meridian/thread-client";

export function replyText(turns: Turn[], turnId: string | null): string | null {
  if (!turnId) return null;
  const view = viewTranscript({ turns, activity: { awaitingSubagents: false } });
  const items = view.items.get(turnId)?.items ?? [];
  const text = items.map((item) => (item.kind === "text" ? item.text : "")).join("");
  return text || null;
}
