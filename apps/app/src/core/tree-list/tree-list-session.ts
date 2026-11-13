/**
 * One list's session in this browser: the stored copy, the tab that owns its connection, and what
 * the app reads: a Yjs document and a sync status. Beside the document sessions
 * (`core/editor/document-session*.ts`), and the same shape: a store with `subscribe` and an
 * immutable snapshot.
 */
import { type TreeListRef, treeRoomName, yjsWsPath } from "@meridian/contracts/protocol";
import { connectTreeList, type ListSyncState } from "@meridian/tree-list-sync";
import type * as Y from "yjs";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";
import { buildSameOriginWsUrl } from "../transport/dev-transport";
import { CollabSchemaWebSocket } from "../transport/hocuspocus-document-transport";
import { StoredListCopy } from "./stored-copy";

/**
 * - `waiting`: the server's list has not been read in this session ("waiting for the list"): an
 *   address that finds no node must wait, not decide
 * - `synced`: the copy holds the server's list and the server holds the copy's records
 * - `offline`: the connection dropped after a sync; the copy still shows what it had and takes
 *   records, which the next connection sends
 * - `rebuilding`: the server refused the copy whole; it is being rebuilt from the server's
 * - `denied`: this account has no access to the list
 */
export type TreeListStatus = "waiting" | "synced" | "offline" | "rebuilding" | "denied";

export type TreeListSnapshot = {
  /** The copy. A rebuild replaces it with a new document: read it from the snapshot each time. */
  readonly doc: Y.Doc;
  readonly status: TreeListStatus;
  /** Whether this tab holds the list's connection or follows the tab that does. */
  readonly role: "owner" | "follower";
};

const statusOf = (state: ListSyncState): TreeListStatus =>
  state === "connecting" ? "waiting" : state;

export class TreeListSession {
  private readonly copy: StoredListCopy;
  private current: TreeListSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly closed = deferred<void>();
  private isClosed = false;
  private connection: { destroy(): void } | null = null;
  private ownStatus: TreeListStatus | null = null;

  constructor(
    readonly accountId: string,
    readonly list: TreeListRef,
    locks: CrossContextLockManager | null = nativeLocks(),
  ) {
    const key = `${accountId}:${treeRoomName(list)}`;
    this.copy = new StoredListCopy(
      `meridian:tree-list:v1:${key}`,
      (status) => {
        if (this.current.role === "follower") this.publish({ status: status as TreeListStatus });
      },
      () => this.ownStatus,
    );
    this.current = { doc: this.copy.doc, status: "waiting", role: "follower" };
    this.copy.subscribe(() => this.publish({ doc: this.copy.doc }));
    void this.copy.loaded.then(() => this.becomeOwnerWhenFree(key, locks));
  }

  private becomeOwnerWhenFree(key: string, locks: CrossContextLockManager | null) {
    if (this.isClosed) return;
    const own = async () => {
      this.publish({ role: "owner" });
      this.connection = connectTreeList({
        roomName: treeRoomName(this.list),
        url: buildSameOriginWsUrl(yjsWsPath()),
        WebSocketPolyfill: CollabSchemaWebSocket,
        copy: this.copy,
        onState: (state) => {
          this.ownStatus = statusOf(state);
          this.copy.announceStatus(this.ownStatus);
          this.publish({ status: this.ownStatus });
        },
      });
      await this.closed.promise;
    };
    // One tab holds the connection; the others wait on the lock and take it when it goes.
    if (locks) void locks.request(`meridian:tree-list:v1:${key}`, { mode: "exclusive" }, own);
    else void own();
  }

  private publish(change: Partial<TreeListSnapshot>) {
    if (this.isClosed) return;
    const next = { ...this.current, ...change };
    if (
      next.doc === this.current.doc &&
      next.status === this.current.status &&
      next.role === this.current.role
    )
      return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): TreeListSnapshot => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.connection?.destroy();
    this.closed.resolve();
    this.listeners.clear();
    this.copy.close();
  }
}
