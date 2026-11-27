import { loroRoomName, type TreeListRef } from "@meridian/contracts/protocol";
import { watchBounces } from "../project-tree/tree-bounces";
import { TreeListSession } from "./tree-list-session";

export type TreeListHandle = { readonly session: TreeListSession; release(): void };

export class TreeListRegistry {
  private readonly sessions = new Map<
    string,
    { session: TreeListSession; unwatch: () => void; holds: number }
  >();
  private closed = false;

  constructor(
    private readonly accountId: string,
    private readonly signedIn: () => boolean,
    private readonly accountChanged: () => void,
  ) {}

  acquire(list: TreeListRef): TreeListHandle {
    if (this.closed) throw new Error("The account's tree lists are closed");
    const key = loroRoomName({ kind: "tree", list });
    let entry = this.sessions.get(key);
    if (!entry) {
      const session = new TreeListSession(this.accountId, list, this.signedIn, this.accountChanged);
      const unwatch = watchBounces(session, `user:${this.accountId}`);
      entry = { session, unwatch, holds: 0 };
      this.sessions.set(key, entry);
    }
    entry.holds += 1;
    const held = entry;
    let released = false;
    return {
      session: held.session,
      release: () => {
        if (released) return;
        released = true;
        held.holds -= 1;
        if (held.holds === 0) {
          held.unwatch();
          held.session.close();
          this.sessions.delete(key);
        }
      },
    };
  }

  get account(): TreeListRef {
    return { kind: "account", userId: this.accountId };
  }

  close() {
    this.closed = true;
    for (const { session, unwatch } of this.sessions.values()) {
      unwatch();
      session.close();
    }
    this.sessions.clear();
  }
}
