/**
 * relative-time — one shared "Nm / Nh / Nd" formatter for the project
 * workspace. Callers pass `nowMs` to keep the value deterministic; the "now"
 * tick policy lives at the call site.
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
