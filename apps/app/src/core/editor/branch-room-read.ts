/**
 * One retained read of a branch (review) room: the single owner of how a reader holds a room. It retains
 * the room, follows whichever session backs it (rebuilding when the server refused the writer's edits),
 * says when the room is unusable (the draft closed, or the session ended), and releases the room on dispose.
 * Editors, row readers and command-time readers all take a room through it; none of them retains, gets or
 * replaces a session itself. A schema reset keeps its terminal session, so the editor can paint its notice.
 */
import type { DocumentSession } from "./document-session";
import type { LiveDocumentSessionRegistry } from "./document-session-registry";

export type BranchRoomRegistry = Pick<
  LiveDocumentSessionRegistry,
  "retainBranchRooms" | "releaseBranchRooms" | "getBranchRoom" | "rebuildBranchRoom"
>;

export interface BranchRoomRead {
  /** The session now backing the room; null while it is rebuilding or once the room is unusable. */
  session(): DocumentSession | null;
  /** The room cannot be used as named: the draft may have a new room or be closed, so ask what it is now. */
  unavailable(): boolean;
  /** Called when the session or availability changes. */
  subscribe(listener: () => void): () => void;
  /** The session once the server has reconciled it; rejects when the room is not available. */
  synced(): Promise<DocumentSession>;
  /** Release the room. */
  dispose(): void;
}

let sequence = 0;

/** Retain `roomKey` for one reader. Throws when the room cannot be opened (the retention is released). */
export function readBranchRoom(registry: BranchRoomRegistry, roomKey: string): BranchRoomRead {
  const owner = `branch-read:${++sequence}`;
  const listeners = new Set<() => void>();
  let current: DocumentSession | null = null;
  let unavailable = false;
  let disposed = false;
  let unwatch: (() => void) | undefined;

  const move = (session: DocumentSession | null, gone: boolean) => {
    if (session === current && gone === unavailable) return;
    current = session;
    unavailable = gone;
    for (const listener of listeners) listener();
  };

  const bind = (session: DocumentSession) => {
    unwatch?.();
    move(session, false);
    unwatch = session.subscribe((snapshot) => {
      if (disposed || current !== session) return;
      const connection = snapshot.connectionState;
      if (connection?.kind === "reset") {
        switch (connection.disposition) {
          case "schema":
            return;
          case "superseded":
            move(null, true);
            return;
          case "refused":
            move(null, false);
            void registry.rebuildBranchRoom(roomKey).then(
              (replacement) => {
                if (!disposed) bind(replacement);
              },
              () => {
                if (!disposed) move(null, true);
              },
            );
            return;
        }
      }
      if (
        snapshot.status === "destroyed" ||
        connection?.kind === "terminal" ||
        connection?.kind === "unauthorized"
      )
        move(null, true);
    });
  };

  registry.retainBranchRooms(owner, [roomKey]);
  try {
    bind(registry.getBranchRoom(roomKey));
  } catch (error) {
    registry.releaseBranchRooms(owner);
    throw error;
  }

  return {
    session: () => current,
    unavailable: () => unavailable,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async synced() {
      const session = current;
      if (!session) throw new Error("The draft's room is not available");
      await session.whenSynced();
      return session;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unwatch?.();
      listeners.clear();
      registry.releaseBranchRooms(owner);
    },
  };
}
