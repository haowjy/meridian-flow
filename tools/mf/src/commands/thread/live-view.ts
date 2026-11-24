import type { Diff } from "@meridian/thread-client/sync";
import { truncate } from "../../core/output";

export type LiveDiff = Diff;

export type LiveReason = "no_turn" | "rewritten" | "read_ended" | "not_ended" | "gap";

export type LiveViewReport =
  | { liveView: "matches" }
  | { liveView: "not_observed"; liveReason: LiveReason }
  | { liveView: "differs"; liveDiff: LiveDiff[] };

const DIFF_TEXT_LIMIT = 120;

export function renderLiveDiff(diffs: readonly LiveDiff[], full: boolean): string {
  const show = (value: string | null) =>
    JSON.stringify(value === null || full ? value : truncate(value, DIFF_TEXT_LIMIT));
  const shown = diffs.map(
    (diff) => `${diff.turnId} ${diff.field} live=${show(diff.live)} server=${show(diff.server)}`,
  );
  return `live view differs from the server (${shown.join("; ")}); the server's state is what was stored`;
}
