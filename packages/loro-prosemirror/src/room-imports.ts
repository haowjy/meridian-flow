import {
  type DocChange,
  type DocKey,
  decodeEnvelope,
  type Envelope,
  type ImportedBatch,
  type RoomDocs,
} from "@meridian/document-model";
import type { EditorView } from "prosemirror-view";

/**
 * The room's one door for remote batches (design §6): a peer's batch is imported here, Live's
 * drafts are forwarded from here, and the editors bound to the room hear of every change from here.
 *
 * A Draft editor binds to the fork's docs, which read Live's text for blocks the draft has not
 * written, so the state is per Live room: a Live batch is forwarded into every draft its holder
 * registered (`registerDraft`) before their editors hear of it, whether or not an editor is bound
 * to the draft (design §2, "Forwarding").
 *
 * The composition hold: a peer's batch is held, as bytes, while any editor on the room (Live's or
 * a draft's) is in an IME composition, and imported in order once the last composition ends.
 * Holding the batch itself, not just the editor's view of it, keeps the binding's invariant:
 * between transactions the editor's document is the docs' read plus the blocks it keeps for its
 * caret, and every local write is computed against that. Gate 1: 24 of 24 compositions with a
 * remote update mid-composition, against 12 of 24 unguarded.
 */
export interface EditorListener {
  /** Called before a batch is imported, while the editor and the docs still agree. */
  before(): void;
  /**
   * Called after, with the doc keys that changed in the docs this listener is bound to, and the
   * peer's batch that changed them, or null for a local write outside the editor (`notifyChanged`).
   */
  after(changed: ReadonlySet<DocKey>, remote: RemoteBatch | null): void;
}

/** A peer's batch as its listeners see it: the turn whose write it is, by doc (`Imported.authors`). */
export type RemoteBatch = Pick<ImportedBatch, "authors">;

/** A batch that is no write landing: a catch-up of history, or a forward of the tab's own typing. */
const UNAUTHORED: RemoteBatch = { authors: () => new Map() };

/** Sends a write the copy made itself on an import (a restore, `RoomDocs.importBatch`) as a local one. */
export type PublishWrite = (changes: DocChange[]) => void;

interface Room {
  views: Set<EditorView>;
  queued: { docs: RoomDocs; batch: Envelope; publish: PublishWrite; landing: boolean }[];
  releasing: boolean;
  /** Each registered draft's fork (`registerDraft`), with what sends a restore its forward writes. */
  drafts: Map<RoomDocs, PublishWrite>;
  listeners: Map<RoomDocs, Set<EditorListener>>;
}

const rooms = new WeakMap<RoomDocs, Room>();

function roomOf(docs: RoomDocs): Room {
  const root = docs.live ?? docs;
  let room = rooms.get(root);
  if (!room) {
    room = {
      views: new Set(),
      queued: [],
      releasing: false,
      drafts: new Map(),
      listeners: new Map(),
    };
    rooms.set(root, room);
  }
  return room;
}

/**
 * Import a peer's batch into `docs` (a Live copy or a draft's fork), or hold it while an editor on
 * the room is composing. Returns null when held, else what the import changed and whether some of
 * it waits on ops not yet seen. Throws on bytes that are not an envelope, before holding anything.
 *
 * A removal the batch brings that did not read typing this copy holds is answered by the import,
 * before any editor reads it (design §1, rule 1), so the block never leaves the typist's screen;
 * `publish` sends that restore. `landing` says the batch is a write reaching the room as it is made,
 * not a catch-up of history (a Join's, a stored copy's, another tab's): only then do its listeners
 * hear who wrote it.
 */
export function importRemoteUpdate(
  docs: RoomDocs,
  bytes: Uint8Array,
  publish: PublishWrite,
  landing: boolean,
): { changed: DocKey[]; pending: boolean } | null {
  const batch = decodeEnvelope(bytes);
  const room = roomOf(docs);
  if (room.queued.length > 0 || composing(room)) {
    room.queued.push({ docs, batch, publish, landing });
    return null;
  }
  return apply(room, docs, batch, publish, landing);
}

/** How many batches are held for this room right now. */
export function heldUpdateCount(docs: RoomDocs): number {
  return rooms.get(docs.live ?? docs)?.queued.length ?? 0;
}

/**
 * Tell the editors on `docs` that a local write outside the editor (a command run in the tab)
 * changed these keys, so they re-read them.
 */
export function notifyChanged(docs: RoomDocs, changed: Iterable<DocKey>) {
  const room = roomOf(docs);
  const keys = new Set(changed);
  for (const listener of room.listeners.get(docs) ?? []) listener.before();
  deliver(room, docs, keys, null);
}

function apply(
  room: Room,
  docs: RoomDocs,
  batch: Envelope,
  publish: PublishWrite,
  landing: boolean,
) {
  for (const draft of room.drafts.keys()) if (draft.isFreed) room.drafts.delete(draft);
  const targets = docs.live ? [docs] : [docs, ...room.drafts.keys()];
  for (const target of targets)
    for (const listener of room.listeners.get(target) ?? []) listener.before();
  const result = docs.importBatch(batch);
  if (result.restore.length) publish(result.restore);
  const changed = new Set(result.changed);
  const remote = landing ? result : UNAUTHORED;
  deliver(room, docs, changed, remote);
  if (!docs.live) forwardInto(room, changed, remote);
  return { changed: result.changed, pending: result.pending };
}

/**
 * Bring every registered draft up to Live, after Live's docs changed by `changed`: by `live`, a
 * peer's batch, or by this copy's own write. A forward brings only what Live's copy holds, so the
 * draft's editors hear who wrote it from Live's import.
 */
function forwardInto(room: Room, changed: ReadonlySet<DocKey>, live: RemoteBatch) {
  for (const [draft, publishDraft] of room.drafts) {
    // The draft reads Live's text for blocks it has not written, and its structure fork follows
    // Live's structure once forwarded.
    const forwarded = draft.forward();
    if (forwarded.restore.length) publishDraft(forwarded.restore);
    const keys = new Set([
      ...forwarded.changed,
      ...[...changed].filter((key) => !draft.texts.has(key)),
    ]);
    deliver(room, draft, keys, live);
  }
}

/**
 * A local write into a Live copy outside an import (its own editor's typing, an Undo): forward
 * the copy's drafts. Their editors hear of it after Live's docs already changed, so a draft
 * editor's caret inside a paragraph this tab's Live editor typed into can land a few characters
 * off; it holds for every other block.
 */
export function forwardLocalWrite(live: RoomDocs, changed: Iterable<DocKey>) {
  const room = rooms.get(live);
  if (!room || live.live) return;
  for (const draft of room.drafts.keys()) if (draft.isFreed) room.drafts.delete(draft);
  if (room.drafts.size === 0) return;
  for (const draft of room.drafts.keys())
    for (const listener of room.listeners.get(draft) ?? []) listener.before();
  forwardInto(room, new Set(changed), UNAUTHORED);
}

/**
 * Register a draft's fork to be forwarded on every batch its Live copy imports; returns the
 * unregister. Its holder (the fork's session) registers it for the fork's whole life, so a fork
 * no editor shows (a Review reference) is forwarded too. `publish` sends what a forward restores.
 */
export function registerDraft(draft: RoomDocs, publish: PublishWrite): () => void {
  if (!draft.live) throw new Error("registerDraft takes a draft's fork");
  const room = roomOf(draft);
  room.drafts.set(draft, publish);
  return () => {
    if (room.drafts.get(draft) === publish) room.drafts.delete(draft);
  };
}

function deliver(
  room: Room,
  docs: RoomDocs,
  changed: ReadonlySet<DocKey>,
  remote: RemoteBatch | null,
) {
  for (const listener of room.listeners.get(docs) ?? []) listener.after(changed, remote);
}

function composing(room: Room): boolean {
  for (const view of room.views) if (!view.isDestroyed && view.composing) return true;
  return false;
}

/** Register a listener for imports into `docs`; returns the unregister. */
export function listenToImports(docs: RoomDocs, listener: EditorListener): () => void {
  const room = roomOf(docs);
  let set = room.listeners.get(docs);
  if (!set) {
    set = new Set();
    room.listeners.set(docs, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) room.listeners.delete(docs);
  };
}

/**
 * Bind `view` to the room's hold. The release waits for ProseMirror to read the composition's last
 * DOM change into its state: it runs from a timer after `compositionend`, and again from every
 * view update, and only when no view on the room is composing. `destroy` releases what the room
 * still holds into docs that are alive, and drops a batch held for docs already freed.
 */
export function attachCompositionHold(docs: RoomDocs, view: EditorView) {
  const room = roomOf(docs);
  room.views.add(view);
  const schedule = () => {
    if (room.queued.length === 0 || room.releasing) return;
    room.releasing = true;
    setTimeout(() => {
      room.releasing = false;
      release(room);
    }, 0);
  };
  view.dom.addEventListener("compositionend", schedule);
  return {
    update: () => {
      if (!view.composing) schedule();
    },
    destroy: () => {
      view.dom.removeEventListener("compositionend", schedule);
      room.views.delete(view);
      release(room);
    },
  };
}

function release(room: Room) {
  while (room.queued.length > 0 && !composing(room)) {
    const next = room.queued.shift();
    if (next && !next.docs.isFreed) apply(room, next.docs, next.batch, next.publish, next.landing);
  }
}
