/** The account's open tree lists: one session per list however many views hold it. */
import { type TreeListRef, treeRoomName } from "@meridian/contracts/protocol";
import { TreeListSession } from "./tree-list-session";

export type TreeListHandle = { readonly session: TreeListSession; release(): void };

export class TreeListRegistry {
  private readonly sessions = new Map<string, { session: TreeListSession; holds: number }>();
  private closed = false;

  constructor(private readonly accountId: string) {}

  /** The list's session, opened if no view holds it. Release the handle when the view goes. */
  acquire(list: TreeListRef): TreeListHandle {
    if (this.closed) throw new Error("The account's tree lists are closed");
    const key = treeRoomName(list);
    let entry = this.sessions.get(key);
    if (!entry) {
      entry = { session: new TreeListSession(this.accountId, list), holds: 0 };
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

  /** The account is signing out or closing: every session ends. */
  close() {
    this.closed = true;
    for (const { session } of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
