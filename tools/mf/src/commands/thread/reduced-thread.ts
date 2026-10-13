/**
 * The CLI's view of a thread as the app would build it: a snapshot hydrated
 * into the shared `InMemoryTurnStore`, then every sequenced event reduced by
 * the shared turn reducer. `thread events` stays a log (`events-map.ts`);
 * turn state is only ever read from here.
 */
import type { AGUIEvent, ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import { createTurnReducer, InMemoryTurnStore, type TurnReducer } from "@meridian/thread-client";
import { truncate } from "../../core/output";
import { assistantText } from "./transcript";

export type LiveDiff = {
  turnId: string;
  field: "status" | "finalText";
  /** What the reduced events show (what the app's live view would have shown). */
  live: string | null;
  /** What the confirming snapshot stored. */
  server: string | null;
};

/** Absent when nothing was followed; a difference never changes the exit code. */
export type LiveViewReport =
  | Record<string, never>
  | { liveView: "matches" }
  | { liveView: "differs"; liveDiff: LiveDiff[] };

export class ReducedThread {
  private readonly store: InMemoryTurnStore;
  private readonly reducer: TurnReducer;

  constructor(private readonly threadId: string) {
    const now = () => new Date().toISOString();
    this.store = new InMemoryTurnStore({ now });
    this.reducer = createTurnReducer({ store: this.store, now });
  }

  /** False when the snapshot is older than what the store already covers. */
  hydrate(snapshot: Pick<ThreadSnapshotResponse, "turns" | "nextSeq">): boolean {
    return this.store.hydrate(this.threadId, snapshot.turns, snapshot.nextSeq);
  }

  /**
   * Applies every delivered event. Which events arrive is the subscription's
   * cursor (`resumeAfterSeq`); `nextSeq` only decides which snapshot is fresh
   * enough to hydrate, so it never filters events here.
   */
  apply(event: AGUIEvent): void {
    this.reducer.applyEvent(this.threadId, event);
  }

  turns(): Turn[] {
    return this.store.turns(this.threadId) ?? [];
  }

  turn(turnId: string): Turn | undefined {
    return this.turns().find((turn) => turn.id === turnId);
  }

  /** Compares the followed turns' reduced status and final text with the confirming snapshot's. */
  compare(snapshot: ThreadSnapshotResponse, turnIds: Iterable<string>): LiveViewReport {
    const diffs: LiveDiff[] = [];
    let compared = 0;
    for (const turnId of new Set(turnIds)) {
      compared += 1;
      const live = this.turn(turnId);
      const server = snapshot.turns.find((turn) => turn.id === turnId);
      if ((live?.status ?? null) !== (server?.status ?? null))
        diffs.push({
          turnId,
          field: "status",
          live: live?.status ?? null,
          server: server?.status ?? null,
        });
      const liveText = live?.role === "assistant" ? assistantText(live) : null;
      const serverText = server?.role === "assistant" ? assistantText(server) : null;
      if (liveText !== serverText)
        diffs.push({
          turnId,
          field: "finalText",
          live: liveText,
          server: serverText,
        });
    }
    if (compared === 0) return {};
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
