/** The account's open tree lists: one session per list however many views hold it. */
import { type TreeListRef, treeRoomName } from "@meridian/contracts/protocol";
import type { TreeRecord } from "@meridian/project-tree";
import { type BounceHost, watchBounces } from "../project-tree/tree-bounces";
import { TreeListSession } from "./tree-list-session";

export type TreeListHandle = { readonly session: TreeListSession; release(): void };

export class TreeListRegistry {
  private readonly sessions = new Map<string, { session: TreeListSession; holds: number }>();
  private closed = false;

  constructor(
    private readonly accountId: string,
    /** Records a recovered copy could not append again: what a client of this build never writes. */
    private readonly onDropped: (records: readonly TreeRecord[]) => void = () => undefined,
    private readonly bounceHost: BounceHost = {
      localText: async () => null,
      endCreatedDraftRoom: () => undefined,
    },
  ) {}

  /** The list's session, opened if no view holds it. Release the handle when the view goes. */
  acquire(list: TreeListRef): TreeListHandle {
    if (this.closed) throw new Error("The account's tree lists are closed");
    const key = treeRoomName(list);
    let entry = this.sessions.get(key);
    if (!entry) {
      const session = new TreeListSession(this.accountId, list, undefined, this.onDropped);
      watchBounces(session, `user:${this.accountId}`, this.bounceHost);
      entry = { session, holds: 0 };
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
          held.session.close();
          this.sessions.delete(key);
        }
      },
    };
  }

  /** The signed-in account's own list. */
  get account(): TreeListRef {
    return { kind: "account", userId: this.accountId };
  }

  /** The account is signing out or closing: every session ends. */
  close() {
    this.closed = true;
    for (const { session } of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
