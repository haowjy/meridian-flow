// @ts-nocheck
/**
 * relative-time — one shared "Nm / Nh / Nd" formatter for the project
 * workspace. Single source so the thread list, chat dock, and Chats overview
 * render identical relative timestamps (previously duplicated per file, which
 * drifted). Pure: callers pass `nowMs` so the value stays deterministic and the
 * "now" tick policy lives at the call site, not here.
 */

/** Format an ISO timestamp as a compact relative age: `now` / `Nm` / `Nh` / `Nd`. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor(Math.max(0, nowMs - then) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
