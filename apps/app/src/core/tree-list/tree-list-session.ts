import { decodeLoroJoinExtra, loroRoomName, type TreeListRef } from "@meridian/contracts/protocol";
import {
  decodeEnvelope,
  docCovers,
  docVersion,
  encodeEnvelope,
  freshPeerId,
  STRUCTURE_KEY,
  withVector,
} from "@meridian/document-model";
import { LIVE, replayView, type TreeProjection, type View } from "@meridian/project-tree";
import { LoroDoc } from "loro-crdt";
import { LocalCopyStore } from "../editor/local-copy-store";
import {
  createLoroRoomTransport,
  type LoroRoomTransport,
  type RoomConnectionState,
} from "../transport/loro-room-transport";
import { treeListCopyPrefix } from "./copy-names";

export type TreeListStatus =
  | "waiting"
  | "synced"
  | "offline"
  | "broken"
  | "unauthenticated"
  | "denied";

export type TreeListSnapshot = {
  /** The copy. A copy of another list is replaced by a new document: read it from the snapshot each time. */
  readonly doc: LoroDoc;
  readonly version: number;
  readonly status: TreeListStatus;
};

const LIST = STRUCTURE_KEY;
const LIST_META = "list";
const COMPACT_EVERY = 200;

type TabMessage = { batch: Uint8Array; list: string | null };

function freshDoc(): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(BigInt(freshPeerId()));
  return doc;
}

function statusOf(state: RoomConnectionState, synced: boolean): TreeListStatus {
  switch (state.kind) {
    case "connected":
      return synced ? "synced" : "waiting";
    case "connecting":
    case "disconnected":
      return synced ? "offline" : "waiting";
    case "signed-out":
      return "unauthenticated";
    case "unauthorized":
      return "denied";
    default:
      return "broken";
  }
}

export class TreeListSession {
  private current: TreeListSnapshot;
  private readonly listeners = new Set<() => void>();
  private isClosed = false;
  private store: LocalCopyStore | null = null;
  private appended = 0;
  private listId: string | null = null;
  private tabs: BroadcastChannel | null = null;
  private transport: LoroRoomTransport | null = null;
  private stopLocal: (() => void) | null = null;
  /** Counts changes to any copy as they land: `version` publishes a microtask later, and a record appended in this one must be in the next replay. */
  private edits = 0;
  private changed = false;
  private readonly retired: LoroDoc[] = [];
  readonly loaded: Promise<void>;

  constructor(
    readonly accountId: string,
    readonly list: TreeListRef,
  ) {
    const doc = freshDoc();
    this.current = { doc, version: 0, status: "waiting" };
    this.watch(doc);
    this.loaded = this.load(
      `${treeListCopyPrefix(accountId)}${loroRoomName({ kind: "tree", list })}`,
    );
  }

  private async load(name: string): Promise<void> {
    if (typeof indexedDB !== "undefined") {
      try {
        const store = await LocalCopyStore.open(indexedDB, name);
        if (this.isClosed) {
          void store.close();
          return;
        }
        const loaded = await store.read();
        if (this.isClosed) {
          void store.close();
          return;
        }
        const snapshot = loaded.snapshots.get(LIST);
        const batches = [
          snapshot,
          ...loaded.updates.map((batch) => decodeEnvelope(batch).get(LIST)),
        ].filter((bytes): bytes is Uint8Array => bytes !== undefined);
        if (batches.length > 0) this.current.doc.importBatch(batches);
        const listId = loaded.meta.get(LIST_META);
        this.listId = typeof listId === "string" ? listId : null;
        this.store = store;
        store.db.onversionchange = () => {
          this.store = null;
          void store.close();
        };
        if (loaded.updates.length > 0) this.compact();
      } catch (error) {
        reportError(error);
      }
    }
    if (this.isClosed) return;
    this.startTabs(name);
    this.connect();
  }

  private watch(doc: LoroDoc) {
    this.stopLocal?.();
    this.stopLocal = doc.subscribeLocalUpdates((bytes) => {
      const batch = encodeEnvelope(new Map([[LIST, bytes]]));
      this.append(batch);
      this.tabs?.postMessage({ batch, list: this.listId } satisfies TabMessage);
      this.transport?.send(batch);
    });
    doc.subscribe(() => this.noteChange(doc));
  }

  private noteChange(doc: LoroDoc) {
    if (doc !== this.current.doc) return;
    this.edits += 1;
    if (this.changed) return;
    this.changed = true;
    queueMicrotask(() => {
      this.changed = false;
      this.publish({ version: this.current.version + 1 });
    });
  }

  private importBatch(batch: Uint8Array, store: boolean) {
    const bytes = decodeEnvelope(batch).get(LIST);
    if (!bytes) return;
    this.current.doc.import(bytes);
    if (store) this.append(batch);
  }

  private append(batch: Uint8Array) {
    const store = this.store;
    if (!store) return;
    void store.append(batch).catch(noop);
    if (++this.appended >= COMPACT_EVERY) this.compact();
  }

  private compact() {
    const store = this.store;
    if (!store) return;
    this.appended = 0;
    void store
      .compact(new Map([[LIST, this.current.doc.export({ mode: "snapshot" })]]))
      .catch(noop);
  }

  private startTabs(name: string) {
    if (typeof BroadcastChannel !== "function") return;
    const tabs = new BroadcastChannel(`meridian:tree-list:v2:${name}`);
    tabs.onmessage = ({ data }: MessageEvent<TabMessage>) => {
      if (data?.batch instanceof Uint8Array && data.list === this.listId)
        this.importBatch(data.batch, false);
    };
    this.tabs = tabs;
  }

  private onJoined = (extra: Uint8Array | undefined): "rejoin" | undefined => {
    const named = decodeLoroJoinExtra(extra).list ?? null;
    if (named === null || named === this.listId) return undefined;
    const fresh = this.listId === null && this.current.doc.oplogFrontiers().length === 0;
    this.listId = named;
    void this.store?.putMeta(LIST_META, named).catch(noop);
    if (fresh) return undefined;
    const doc = freshDoc();
    this.watch(doc);
    this.store?.compact(new Map([[LIST, doc.export({ mode: "snapshot" })]])).catch(noop);
    // A render may still hold the old copy's snapshot: it is freed with the session.
    this.retired.push(this.current.doc);
    this.publish({ doc, version: this.current.version + 1 });
    return "rejoin";
  };

  private connect() {
    const transport = createLoroRoomTransport({
      room: { kind: "tree", list: this.list },
      peer: this.current.doc.peerIdStr,
      copy: {
        version: () => new Map([[LIST, docVersion(this.current.doc)]]),
        exportSince: (since) => {
          const doc = this.current.doc;
          const from = since.get(LIST) ?? new Map();
          if (docCovers(from, docVersion(doc))) return null;
          const update = withVector(from, (vector) => doc.export({ mode: "update", from: vector }));
          return encodeEnvelope(new Map([[LIST, update]]));
        },
        importRemote: (batch) => this.importBatch(batch, true),
      },
      onJoined: this.onJoined,
    });
    this.transport = transport;
    let state: RoomConnectionState = { kind: "connecting", attempt: 1 };
    const publishStatus = () => this.publish({ status: statusOf(state, transport.synced) });
    transport.subscribeStatus((next) => {
      state = next;
      publishStatus();
    });
    void transport.whenSynced.then(publishStatus);
  }

  private publish(change: Partial<TreeListSnapshot>) {
    if (this.isClosed) return;
    const next = { ...this.current, ...change };
    if (
      next.doc === this.current.doc &&
      next.version === this.current.version &&
      next.status === this.current.status
    )
      return;
    this.current = next;
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): TreeListSnapshot => this.current;

  private readonly replayed = new Map<
    string | null,
    { doc: LoroDoc; edits: number; projection: TreeProjection }
  >();

  replay(view: View = LIVE): TreeProjection {
    const { doc } = this.current;
    const held = this.replayed.get(view.draft);
    if (held?.doc === doc && held.edits === this.edits) return held.projection;
    const projection = replayView(doc, view);
    this.replayed.set(view.draft, { doc, edits: this.edits, projection });
    return projection;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.listeners.clear();
    this.transport?.destroy();
    this.tabs?.close();
    this.stopLocal?.();
    const store = this.store;
    this.store = null;
    void store?.close();
    this.replayed.clear();
    for (const doc of [...this.retired, this.current.doc]) doc.free();
  }
}

function noop() {}
