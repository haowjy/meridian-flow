/**
 * This CLI follower's own reduction of a thread: a snapshot hydrated into the
 * shared `InMemoryTurnStore`, then every sequenced event reduced by the shared
 * turn reducer. `thread events` stays a log (`events-map.ts`).
 *
 * `compare` is a bounded diagnostic. It checks only the reduced turn status and
 * final assistant text against the confirming snapshot. It is not a certificate
 * of any browser screen: it leaves out tools, reasoning, interrupts, the
 * optimistic UI and the app's visible-turn policy, and the app reconciles to the
 * server at turn end. `differs` is a lead to investigate, `matches` does not
 * prove a screen was right, and neither changes the exit code. The planned rule
 * is that once the chat session's sync is shared, a live disagreement will fail
 * with exit 6; that is not true yet. See
 * https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/engineering/dev-cli/mf-claims-are-proofs.md
 *
 * Snapshot freshness (`nextSeq`) and replay coverage (`resumeAfterSeq`) are
 * separate facts: `nextSeq` only decides which snapshot may be hydrated, and
 * the subscription's cursor decides which events arrive. Every arrival is applied.
 */
import type { AGUIEvent, ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import { createTurnReducer, InMemoryTurnStore, type TurnReducer } from "@meridian/thread-client";
import { truncate } from "../../core/output";
import { replyText } from "./reply-text";

export type LiveDiff = {
  turnId: string;
  field: "status" | "finalText";
  /** What this CLI follower's reduced events show; not what any browser screen showed. */
  live: string | null;
  /** What the confirming snapshot stored. */
  server: string | null;
};

/**
 * Absent when nothing was followed. `not_observed`: the follow had a replay gap,
 * a compared turn's events were not seen from its start, or snapshot recovery overwrote them, so there is nothing
 * fair to compare. A difference never changes the exit code.
 */
export type LiveViewReport =
  | Record<string, never>
  | { liveView: "matches" }
  | { liveView: "not_observed" }
  | { liveView: "differs"; liveDiff: LiveDiff[] };

export class ReducedThread {
  private readonly store: InMemoryTurnStore;
  private readonly reducer: TurnReducer;
  /** Turns whose beginning this follower holds: in a hydrated snapshot, or their RUN_STARTED was applied. */
  private readonly observedFromStart = new Set<string>();

  constructor(private readonly threadId: string) {
    const now = () => new Date().toISOString();
    this.store = new InMemoryTurnStore({ now });
    this.reducer = createTurnReducer({ store: this.store, now });
  }

  /** False when the snapshot is older than what the store already covers. */
  hydrate(snapshot: Pick<ThreadSnapshotResponse, "turns" | "nextSeq">): boolean {
    const accepted = this.store.hydrate(this.threadId, snapshot.turns, snapshot.nextSeq);
    if (accepted) for (const turn of snapshot.turns) this.observedFromStart.add(turn.id);
    return accepted;
  }

  /**
   * Anchor recovery: hydrates a snapshot mid-follow. It overwrites the store's text and status
   * for every turn it holds, so those turns stop being stream evidence: `compare` reports
   * `not_observed` for them rather than comparing the server with itself.
   */
  recover(snapshot: Pick<ThreadSnapshotResponse, "turns" | "nextSeq">): void {
    if (!this.store.hydrate(this.threadId, snapshot.turns, snapshot.nextSeq)) return;
    for (const turn of snapshot.turns) this.observedFromStart.delete(turn.id);
  }

  /**
   * Whether a switch divider is held for a turn this follower lacks. User turns are not on the
   * event stream, so only a snapshot brings the anchor (or releases the divider, if it covers
   * the switch frame). The app asks the same shared store question.
   */
  awaitsAnchor(): boolean {
    return this.store.dividersAwaitingAnchor(this.threadId).length > 0;
  }

  /**
   * Applies every delivered event. Which events arrive is the subscription's
   * cursor (`resumeAfterSeq`); `nextSeq` only decides which snapshot is fresh
   * enough to hydrate, so it never filters events here. The event's seq is required, as in the
   * app: a removal (`messages.handed_back`) tombstones its turns at that seq, so a snapshot read
   * before it can't bring them back.
   */
  apply(event: AGUIEvent, seq: string): void {
    if (event.type === "RUN_STARTED") this.observedFromStart.add(event.runId);
    this.reducer.applyEvent(this.threadId, event, seq);
  }

  turns(): Turn[] {
    return this.store.turns(this.threadId) ?? [];
  }

  turn(turnId: string): Turn | undefined {
    return this.turns().find((turn) => turn.id === turnId);
  }

  /**
   * Compares the followed turns' reduced status and final text with the
   * confirming snapshot's. `truncated` is a replay gap in the follow.
   */
  compare(
    snapshot: ThreadSnapshotResponse,
    turnIds: Iterable<string>,
    truncated: boolean,
  ): LiveViewReport {
    const diffs: LiveDiff[] = [];
    const ids = new Set(turnIds);
    if (ids.size === 0) return {};
    if (truncated || [...ids].some((id) => !this.observedFromStart.has(id)))
      return { liveView: "not_observed" };
    const liveTurns = this.turns();
    for (const turnId of ids) {
      const live = this.turn(turnId);
      const server = snapshot.turns.find((turn) => turn.id === turnId);
      if ((live?.status ?? null) !== (server?.status ?? null))
        diffs.push({
          turnId,
          field: "status",
          live: live?.status ?? null,
          server: server?.status ?? null,
        });
      const liveText = live?.role === "assistant" ? replyText(liveTurns, turnId) : null;
      const serverText = server?.role === "assistant" ? replyText(snapshot.turns, turnId) : null;
      if (liveText !== serverText)
        diffs.push({
          turnId,
          field: "finalText",
          live: liveText,
          server: serverText,
        });
    }
    return diffs.length === 0 ? { liveView: "matches" } : { liveView: "differs", liveDiff: diffs };
  }
}

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
