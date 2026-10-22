/**
 * What `./mf` reports of the end-of-turn check: `liveView` and its reasons. The checks themselves are
 * the shared `ThreadSync`'s (`@meridian/thread-client/sync`); this is how a command words them.
 *
 * `liveView` is a diagnostic comparison of client state: when the stream's own frames ended an
 * assistant turn, did the next applied read agree with the turn's status and own text? It is not a
 * certificate of any screen (no rows, tools or paint), and it never changes a claim or the exit
 * code: only the proving read decides those. `differs` is a lead to investigate; `matches` does
 * not prove a screen was right. A planned follow-up lets a true disagreement fail with exit 6; that
 * is not true yet. See
 * https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/dev-cli/mf-claims-are-proofs.md
 */
import type { Diff } from "@meridian/thread-client/sync";
import { truncate } from "../../core/output";

export type LiveDiff = Diff;

/** Why a `liveView` is `not_observed`, so a run records which reason appears and how often. */
export type LiveReason =
  /** The claim names no assistant turn. */
  | "no_turn"
  /** A read seeded text (including at join), changed a streaming turn, or ended it before replay. */
  | "rewritten"
  /** A read showed the turn terminal before the stream wrote it, so the stream never ended it here. */
  | "read_ended"
  /** The stream did not end the turn within the command's catch-up. */
  | "not_ended"
  /** The stream had a gap reaching past the claim's cursor, or of unknown range. */
  | "gap";

/** Commands omit these fields when nothing was followed. */
export type LiveViewReport =
  | { liveView: "matches" }
  | { liveView: "not_observed"; liveReason: LiveReason }
  | { liveView: "differs"; liveDiff: LiveDiff[] };

const DIFF_TEXT_LIMIT = 120;

/** Text-mode note; the JSON `liveDiff` always carries the full values. */
export function renderLiveDiff(diffs: readonly LiveDiff[], full: boolean): string {
  const show = (value: string | null) =>
    JSON.stringify(value === null || full ? value : truncate(value, DIFF_TEXT_LIMIT));
  const shown = diffs.map(
    (diff) => `${diff.turnId} ${diff.field} live=${show(diff.live)} server=${show(diff.server)}`,
  );
  return `live view differs from the server (${shown.join("; ")}); the server's state is what was stored`;
}
