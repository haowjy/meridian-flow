/** The account's open tree lists: one session per list however many views hold it. */
import type { TreeSaw } from "@meridian/contracts/branches";
import { type TreeListRef, treeRoomName } from "@meridian/contracts/protocol";
import type { TreeRecord } from "@meridian/project-tree";
import * as Y from "yjs";
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

  /**
   * What the project's lists and the account's hold now, as the Apply press sends it (`saw`): the
   * state vector of each list this tab has open and in sync. A list that is not synced is left
   * out: its own records may not be on the server, and the server would wait for them.
   */
  sawOf(projectId: string): TreeSaw {
    const vectorOf = (list: TreeListRef): string | undefined => {
      const snapshot = this.sessions.get(treeRoomName(list))?.session.getSnapshot();
      if (snapshot?.status !== "synced") return undefined;
      const bytes = Y.encodeStateVector(snapshot.doc);
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
    };
    const project = vectorOf({ kind: "project", projectId });
    const account = vectorOf({ kind: "account", userId: this.accountId });
    return { ...(project ? { project } : {}), ...(account ? { account } : {}) };
  }

  /** The account is signing out or closing: every session ends. */
  close() {
    this.closed = true;
    for (const { session } of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
