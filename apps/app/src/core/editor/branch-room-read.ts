/**
 * One retained read of a branch (review) room: the single owner of how a reader holds a room. It retains
 * the room, follows whichever session backs it, and says what the room is to a reader right now:
 *
 * - `usable`: a live session. Commands and editors may read and write it.
 * - `rebuilding`: the server refused the writer's edits, or the previous session is still being torn
 *   down. The read joins the pool's one rebuild and becomes `usable` again; refused edits are never replayed.
 * - `fenced`: a schema reset. Its terminal session is kept so an editor can paint the notice, and it is
 *   never a target for a command.
 * - `unavailable`: the draft closed, its room was superseded, or the session ended. Ask what the draft is now.
 * - `error`: opening or rebuilding the room failed. `retry()` asks again.
 *
 * Editors, row readers and command-time readers all take a room through it; none of them retains, gets or
 * replaces a session itself. A command holds a session across awaits only through `synced()` and
 * `assertLive()`, which refuse a session that has since retired.
 */
import type { DocumentSession, DocumentSessionSnapshot } from "./document-session";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";

export type BranchRoomRegistry = Pick<
  LiveDocumentSessionRegistry,
  "retainBranchRooms" | "releaseBranchRooms" | "getBranchRoom" | "rebuildBranchRoom"
>;

export type BranchRoomState =
  | { kind: "usable"; session: DocumentSession }
  | { kind: "fenced"; session: DocumentSession }
  | { kind: "rebuilding" }
  | { kind: "unavailable" }
  | { kind: "error"; error: unknown };

/** A command's session retired (or the read ended) before the command finished with it. */
export class BranchRoomRetiredError extends Error {
  constructor(detail = "The draft's room is not available") {
    super(detail);
    this.name = "BranchRoomRetiredError";
  }
}

export interface BranchRoomRead {
  state(): BranchRoomState;
  /** The session an editor presents: the usable one, or the fenced one that carries the schema notice. */
  session(): DocumentSession | null;
  /** The session a command may act on; null unless the room is usable right now. */
  usable(): DocumentSession | null;
  /** Called when the state changes. */
  subscribe(listener: () => void): () => void;
  /**
   * The usable session once the server has reconciled it. Waits through a rebuild and returns the
   * replacement; rejects when the room is unavailable, fenced, failed or released, or the session retired
   * while it waited.
   */
  synced(): Promise<DocumentSession>;
  /** Throws `BranchRoomRetiredError` unless `session` is still the usable one: call before each read or write after an await. */
  assertLive(session: DocumentSession): void;
  /** Ask again after `error` or `unavailable`. */
  retry(): void;
  /** Release the room. */
  dispose(): void;
}

let sequence = 0;

type Verdict = "usable" | "fenced" | "refused" | "gone";

function judge(snapshot: DocumentSessionSnapshot): Verdict {
  const connection = snapshot.connectionState;
  if (connection?.kind === "reset") {
    if (connection.disposition === "schema") return "fenced";
    return connection.disposition === "refused" ? "refused" : "gone";
  }
  if (
    snapshot.status === "destroyed" ||
    connection?.kind === "terminal" ||
    connection?.kind === "unauthorized"
  )
    return "gone";
  return "usable";
}

/** Retain `roomKey` for one reader. Never throws: a room still being torn down is joined, a failure is the `error` state. */
export function readBranchRoom(registry: BranchRoomRegistry, roomKey: string): BranchRoomRead {
  const owner = `branch-read:${++sequence}`;
  const listeners = new Set<() => void>();
  const waiters = new Set<() => void>();
  let state: BranchRoomState = { kind: "rebuilding" };
  let bound: DocumentSession | null = null;
  let disposed = false;
  let unwatch: (() => void) | undefined;
  /** Bumped whenever a new acquisition begins, so a superseded one cannot publish. */
  let attempt = 0;

  const move = (next: BranchRoomState) => {
    const same =
      next.kind === state.kind &&
      (next.kind === "usable" || next.kind === "fenced"
        ? state.kind === next.kind && state.session === next.session
        : next.kind === "error"
          ? state.kind === "error" && state.error === next.error
          : true);
    if (same) return;
    state = next;
    for (const listener of listeners) listener();
    for (const wake of [...waiters]) wake();
  };

  const changed = () =>
    new Promise<void>((resolve) => {
      const wake = () => {
        waiters.delete(wake);
        resolve();
      };
      waiters.add(wake);
    });

  const rebuild = () => {
    const mine = ++attempt;
    move({ kind: "rebuilding" });
    void registry.rebuildBranchRoom(roomKey).then(
      (replacement) => {
        if (!disposed && attempt === mine) bind(replacement);
      },
      (error) => {
        if (!disposed && attempt === mine) move({ kind: "error", error });
      },
    );
  };

  const bind = (session: DocumentSession) => {
    unwatch?.();
    bound = session;
    let refused = false;
    unwatch = session.subscribe((snapshot) => {
      if (disposed || bound !== session || refused) return;
      switch (judge(snapshot)) {
        case "usable":
          move({ kind: "usable", session });
          return;
        case "fenced":
          move({ kind: "fenced", session });
          return;
        case "gone":
          move({ kind: "unavailable" });
          return;
        case "refused":
          // The pool retires the session with this very notification; the rebuild joins that teardown.
          refused = true;
          rebuild();
          return;
      }
    });
  };

  const acquire = () => {
    try {
      bind(registry.getBranchRoom(roomKey));
    } catch {
      // The room is quarantined behind an unfinished teardown, or cannot be opened: the rebuild waits
      // the teardown out and reports a genuine failure as the `error` state.
      rebuild();
    }
  };

  const usable = (): DocumentSession | null => {
    if (state.kind !== "usable") return null;
    return judge(state.session.getSnapshot()) === "usable" ? state.session : null;
  };

  registry.retainBranchRooms(owner, [roomKey]);
  acquire();

  return {
    state: () => state,
    session: () => (state.kind === "usable" || state.kind === "fenced" ? state.session : null),
    usable,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async synced() {
      for (;;) {
        if (disposed) throw new BranchRoomRetiredError("The draft's room was released");
        if (state.kind === "rebuilding") {
          await changed();
          continue;
        }
        if (state.kind !== "usable") throw new BranchRoomRetiredError();
        const session = state.session;
        await session.whenSynced();
        // `whenSynced` also resolves when destruction ends the session: only a session still usable counts.
        if (disposed) throw new BranchRoomRetiredError("The draft's room was released");
        if (usable() === session) return session;
        if (state.kind === "usable" && state.session === session)
          throw new BranchRoomRetiredError();
      }
    },
    assertLive(session) {
      if (disposed || usable() !== session) throw new BranchRoomRetiredError();
    },
    retry() {
      if (disposed) return;
      if (state.kind === "error" || state.kind === "unavailable") rebuild();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unwatch?.();
      listeners.clear();
      registry.releaseBranchRooms(owner);
      for (const wake of [...waiters]) wake();
    },
  };
}

/**
 * Run `work` against the room's synced session, again against the replacement if the session retires before
 * `work` finishes (it calls `read.assertLive` before writing). Refused edits are never replayed: each
 * attempt starts from whatever the replacement holds.
 */
export async function withLiveRoom<T>(
  read: BranchRoomRead,
  work: (session: DocumentSession) => Promise<T>,
): Promise<T> {
  for (let attempts = 1; ; attempts++) {
    const session = await read.synced();
    try {
      return await work(session);
    } catch (error) {
      if (!(error instanceof BranchRoomRetiredError) || attempts >= 3) throw error;
    }
  }
}
