import {
  answerRemovals,
  type DocChange,
  type DocKey,
  decodeEnvelope,
  type Envelope,
  type RoomDocs,
  STRUCTURE_KEY,
} from "@meridian/document-model";
import type { EditorView } from "prosemirror-view";

/**
 * The composition guard and the one door for remote batches (design §6). A peer's batch is held,
 * as bytes, while any editor on the room is in an IME composition, and imported in order once the
 * last composition ends. Holding the batch itself, not just the editor's view of it, keeps the
 * binding's invariant: between transactions the editor's document is the docs' read plus the
 * blocks it keeps for its caret, and every local write is computed against that. Gate 1: 24 of 24 compositions with a remote update
 * mid-composition, against 12 of 24 unguarded.
 *
 * A Draft editor binds to the fork's docs, which read Live's text for blocks the draft has not
 * written, so the hold is per Live room: a draft's editors hold Live's batches too, and a Live
 * batch is forwarded into every registered draft before their editors hear of it.
 */
export interface EditorListener {
  /** Called before a batch is imported, while the editor and the docs still agree. */
  before(): void;
  /**
   * Called after, with the doc keys that changed in the docs this listener is bound to, and
   * whether a peer's batch changed them (else a local write outside the editor, `notifyChanged`).
   */
  after(changed: ReadonlySet<DocKey>, remote: boolean): void;
}

/** Sends a write the copy made itself on importing a batch (a restore) as a local one. */
export type PublishWrite = (changes: DocChange[]) => void;

interface Hold {
  views: Set<EditorView>;
  queued: { docs: RoomDocs; batch: Envelope; publish: PublishWrite }[];
  releasing: boolean;
  drafts: Set<RoomDocs>;
  listeners: Map<RoomDocs, Set<EditorListener>>;
}

const holds = new WeakMap<RoomDocs, Hold>();

function holdFor(docs: RoomDocs): Hold {
  const root = docs.live ?? docs;
  let hold = holds.get(root);
  if (!hold) {
    hold = {
      views: new Set(),
      queued: [],
      releasing: false,
      drafts: new Set(),
      listeners: new Map(),
    };
    holds.set(root, hold);
  }
  return hold;
}

/**
 * Import a peer's batch into `docs` (a Live copy or a draft's fork), or hold it while an editor on
 * the room is composing. Returns null when held, else what the import changed and whether some of
 * it waits on ops not yet seen. Throws on bytes that are not an envelope, before holding anything.
 *
 * A removal the batch brings that did not read typing this copy holds is answered here, after the
 * import and before any editor reads it (`answerRemovals`, design §1), so the block never leaves
 * the typist's screen; `publish` sends that restore.
 */
export function importRemoteUpdate(
  docs: RoomDocs,
  bytes: Uint8Array,
  publish: PublishWrite,
): { changed: DocKey[]; pending: boolean } | null {
  const batch = decodeEnvelope(bytes);
  const hold = holdFor(docs);
  if (hold.queued.length > 0 || composing(hold)) {
    hold.queued.push({ docs, batch, publish });
    return null;
  }
  return apply(hold, docs, batch, publish);
}

/** How many batches are held for this room right now. */
export function heldUpdateCount(docs: RoomDocs): number {
  return holds.get(docs.live ?? docs)?.queued.length ?? 0;
}

/**
 * Tell the editors on `docs` that a local write outside the editor (a command run in the tab)
 * changed these keys, so they re-read them.
 */
export function notifyChanged(docs: RoomDocs, changed: Iterable<DocKey>) {
  const hold = holdFor(docs);
  const keys = new Set(changed);
  for (const listener of hold.listeners.get(docs) ?? []) listener.before();
  deliver(hold, docs, keys, false);
}

function apply(hold: Hold, docs: RoomDocs, batch: Envelope, publish: PublishWrite) {
  for (const draft of hold.drafts) if (draft.isFreed) hold.drafts.delete(draft);
  const targets = docs.live ? [docs] : [docs, ...hold.drafts];
  for (const target of targets)
    for (const listener of hold.listeners.get(target) ?? []) listener.before();
  const before = docs.structure.frontiers();
  const result = docs.importBatch(batch);
  const changed = new Set(result.changed);
  if (changed.has(STRUCTURE_KEY)) {
    const restored = answerRemovals(docs, before);
    if (restored) publish([restored]);
  }
  deliver(hold, docs, changed, true);
  if (!docs.live)
    for (const draft of hold.drafts) {
      // The draft reads Live's text for blocks it has not written, and its structure fork follows
      // Live's structure once forwarded.
      const keys = new Set([
        ...draft.forward(),
        ...[...changed].filter((key) => !draft.texts.has(key)),
      ]);
      deliver(hold, draft, keys, true);
    }
  return result;
}

function deliver(hold: Hold, docs: RoomDocs, changed: ReadonlySet<DocKey>, remote: boolean) {
  for (const listener of hold.listeners.get(docs) ?? []) listener.after(changed, remote);
}

function composing(hold: Hold): boolean {
  for (const view of hold.views) if (!view.isDestroyed && view.composing) return true;
  return false;
}

/**
 * Register a listener for imports into `docs`; returns the unregister. A draft's fork with a
 * listener is forwarded on every Live batch imported here.
 */
export function listenToImports(docs: RoomDocs, listener: EditorListener): () => void {
  const hold = holdFor(docs);
  let set = hold.listeners.get(docs);
  if (!set) {
    set = new Set();
    hold.listeners.set(docs, set);
  }
  set.add(listener);
  if (docs.live) hold.drafts.add(docs);
  return () => {
    set.delete(listener);
    if (set.size > 0) return;
    hold.listeners.delete(docs);
    hold.drafts.delete(docs);
  };
}

/**
 * Bind `view` to the room's hold. The release waits for ProseMirror to read the composition's last
 * DOM change into its state: it runs from a timer after `compositionend`, and again from every
 * view update, and only when no view on the room is composing. `destroy` releases what the room
 * still holds into docs that are alive, and drops a batch held for docs already freed.
 */
export function attachCompositionHold(docs: RoomDocs, view: EditorView) {
  const hold = holdFor(docs);
  hold.views.add(view);
  const schedule = () => {
    if (hold.queued.length === 0 || hold.releasing) return;
    hold.releasing = true;
    setTimeout(() => {
      hold.releasing = false;
      release(hold);
    }, 0);
  };
  view.dom.addEventListener("compositionend", schedule);
  return {
    update: () => {
      if (!view.composing) schedule();
    },
    destroy: () => {
      view.dom.removeEventListener("compositionend", schedule);
      hold.views.delete(view);
      release(hold);
    },
  };
}

function release(hold: Hold) {
  while (hold.queued.length > 0 && !composing(hold)) {
    const next = hold.queued.shift();
    if (next && !next.docs.isFreed) apply(hold, next.docs, next.batch, next.publish);
  }
}
