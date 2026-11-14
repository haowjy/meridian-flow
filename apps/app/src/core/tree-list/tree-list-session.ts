/**
 * One list's session in this browser: the stored copy, the tab that owns its connection, and what
 * the app reads: a Yjs document and a sync status. Beside the document sessions
 * (`core/editor/document-session*.ts`), and the same shape: a store with `subscribe` and an
 * immutable snapshot.
 */
import { type TreeListRef, treeRoomName, yjsWsPath } from "@meridian/contracts/protocol";
import { LIVE, replayView, type TreeProjection, type TreeRecord } from "@meridian/project-tree";
import { connectTreeList, type ListSyncState } from "@meridian/tree-list-sync";
import type * as Y from "yjs";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";
import { buildSameOriginWsUrl } from "../transport/dev-transport";
import { CollabSchemaWebSocket } from "../transport/hocuspocus-document-transport";
import { treeListCopyPrefix } from "./copy-names";
import { StoredListCopy } from "./stored-copy";

/**
 * - `waiting`: the server's list has not been read in this session ("waiting for the list"): an
 *   address that finds no node must wait, not decide
 * - `synced`: the copy holds the server's list and the server holds the copy's records
 * - `offline`: the connection dropped after a sync; the copy still shows what it had and takes
 *   records, which the next connection sends
 * - `rebuilding`: the server refused the copy whole; it is being rebuilt from the server's
 * - `read-only`: synced, but the account may not write the list: the server keeps none of the
 *   copy's records
 * - `unauthenticated`: the sign-in did not hold; the writer signs in again. Nothing is known about access.
 * - `denied`: this account has no access to the list
 */
export type TreeListStatus =
  | "waiting"
  | "synced"
  | "read-only"
  | "offline"
  | "rebuilding"
  | "unauthenticated"
  | "denied";

export type TreeListSnapshot = {
  /** The copy. A rebuild replaces it with a new document: read it from the snapshot each time. */
  readonly doc: Y.Doc;
  /** Counts the changes to `doc` (records appended here, in another tab or by the server) and its replacements: what a reader of the replay recomputes on. */
  readonly version: number;
  readonly status: TreeListStatus;
  /** Whether this tab holds the list's connection or follows the tab that does. */
  readonly role: "owner" | "follower";
  /** Records the server kept refusing after rebuilds, dropped from the copy's sends: the writer's work it never kept. */
  readonly rejected: readonly TreeRecord[];
};

const statusOf = (state: ListSyncState): TreeListStatus =>
  state === "connecting" ? "waiting" : state;

export class TreeListSession {
  private readonly copy: StoredListCopy;
  private current: TreeListSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly closed = deferred<void>();
  private readonly cancelLockRequest = new AbortController();
  private isClosed = false;
  private ownStatus: TreeListStatus | null = null;

  constructor(
    readonly accountId: string,
    readonly list: TreeListRef,
    locks: CrossContextLockManager | null = nativeLocks(),
  ) {
    const key = `${accountId}:${treeRoomName(list)}`;
    this.copy = new StoredListCopy(
      `${treeListCopyPrefix(accountId)}${treeRoomName(list)}`,
      (status) => {
        if (this.current.role === "follower") this.publish({ status: status as TreeListStatus });
      },
      () => this.ownStatus,
    );
    this.current = {
      doc: this.copy.doc,
      version: 0,
      status: "waiting",
      role: "follower",
      rejected: [],
    };
    this.observe(this.copy.doc);
    this.copy.subscribe(() => {
      this.observe(this.copy.doc);
      this.publish({ doc: this.copy.doc, version: this.current.version + 1 });
    });
    void this.copy.loaded.then(() => this.becomeOwnerWhenFree(key, locks));
  }

  private observed: Y.Doc | null = null;
  private changed = false;
  /** Counts updates to any copy as they land: `version` publishes a microtask later, and a record appended in this one must be in the next replay. */
  private edits = 0;

  /** Publishes a new version for each burst of changes to the copy, not for each update of it. */
  private observe(doc: Y.Doc) {
    if (this.observed === doc) return;
    this.observed = doc;
    doc.on("update", () => {
      this.edits += 1;
      if (this.changed || doc !== this.copy.doc) return;
      this.changed = true;
      queueMicrotask(() => {
        this.changed = false;
        this.publish({ version: this.current.version + 1 });
      });
    });
  }

  private becomeOwnerWhenFree(key: string, locks: CrossContextLockManager | null) {
    if (this.isClosed) return;
    const own = async () => {
      // A request granted after the session closed is a lock nobody asked for any more.
      if (this.isClosed) return;
      this.publish({ role: "owner" });
      const connection = connectTreeList({
        roomName: treeRoomName(this.list),
        url: buildSameOriginWsUrl(yjsWsPath()),
        WebSocketPolyfill: CollabSchemaWebSocket,
        copy: this.copy,
        onState: (state) => {
          this.ownStatus = statusOf(state);
          this.copy.announceStatus(this.ownStatus);
          this.publish({ status: this.ownStatus });
        },
        onRejected: (records) => this.publish({ rejected: [...this.current.rejected, ...records] }),
      });
      // The connection lives as long as the lock: the lock is released when the session closes.
      await this.closed.promise;
      connection.destroy();
    };
    // One tab holds the connection; the others wait on the lock and take it when it goes.
    if (locks)
      void locks
        .request(
          `meridian:tree-list:v1:${key}`,
          { mode: "exclusive", signal: this.cancelLockRequest.signal },
          own,
        )
        .catch((cause: unknown) => {
          // Closing the session cancels a request still waiting: that is the request ending, not a fault.
          if (!(cause instanceof DOMException && cause.name === "AbortError")) throw cause;
        });
    else void own();
  }

  private publish(change: Partial<TreeListSnapshot>) {
    if (this.isClosed) return;
    const next = { ...this.current, ...change };
    if (
      next.doc === this.current.doc &&
      next.version === this.current.version &&
      next.status === this.current.status &&
      next.role === this.current.role &&
      next.rejected === this.current.rejected
    )
      return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): TreeListSnapshot => this.current;

  private replayed: { doc: Y.Doc; edits: number; projection: TreeProjection } | null = null;

  /** The live replay of the copy as it stands, records appended a moment ago included: one replay per change however many views and writers read it. */
  replay(): TreeProjection {
    const { doc } = this.current;
    if (this.replayed?.doc !== doc || this.replayed.edits !== this.edits)
      this.replayed = { doc, edits: this.edits, projection: replayView(doc, LIVE) };
    return this.replayed.projection;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cancelLockRequest.abort();
    this.closed.resolve();
    this.listeners.clear();
    this.copy.close();
  }
}
