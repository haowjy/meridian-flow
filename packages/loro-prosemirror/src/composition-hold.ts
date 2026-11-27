import {
  type DocChange,
  type DocKey,
  decodeEnvelope,
  type Envelope,
  type RoomDocs,
} from "@meridian/document-model";
import type { EditorView } from "prosemirror-view";

export interface EditorListener {
  before(): void;
  after(changed: ReadonlySet<DocKey>, remote: boolean): void;
}

export type PublishWrite = (changes: DocChange[]) => void;

interface Hold {
  views: Set<EditorView>;
  queued: { docs: RoomDocs; batch: Envelope; publish: PublishWrite }[];
  releasing: boolean;
  drafts: Map<RoomDocs, PublishWrite>;
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
      drafts: new Map(),
      listeners: new Map(),
    };
    holds.set(root, hold);
  }
  return hold;
}

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

export function heldUpdateCount(docs: RoomDocs): number {
  return holds.get(docs.live ?? docs)?.queued.length ?? 0;
}

export function notifyChanged(docs: RoomDocs, changed: Iterable<DocKey>) {
  const hold = holdFor(docs);
  const keys = new Set(changed);
  for (const listener of hold.listeners.get(docs) ?? []) listener.before();
  deliver(hold, docs, keys, false);
}

function apply(hold: Hold, docs: RoomDocs, batch: Envelope, publish: PublishWrite) {
  for (const draft of hold.drafts.keys()) if (draft.isFreed) hold.drafts.delete(draft);
  const targets = docs.live ? [docs] : [docs, ...hold.drafts.keys()];
  for (const target of targets)
    for (const listener of hold.listeners.get(target) ?? []) listener.before();
  const result = docs.importBatch(batch);
  if (result.restore.length) publish(result.restore);
  const changed = new Set(result.changed);
  deliver(hold, docs, changed, true);
  if (!docs.live) forwardInto(hold, changed);
  return { changed: result.changed, pending: result.pending };
}

function forwardInto(hold: Hold, changed: ReadonlySet<DocKey>) {
  for (const [draft, publishDraft] of hold.drafts) {
    const forwarded = draft.forward();
    if (forwarded.restore.length) publishDraft(forwarded.restore);
    const keys = new Set([
      ...forwarded.changed,
      ...[...changed].filter((key) => !draft.texts.has(key)),
    ]);
    deliver(hold, draft, keys, true);
  }
}

export function forwardLocalWrite(live: RoomDocs, changed: Iterable<DocKey>) {
  const hold = holds.get(live);
  if (!hold || live.live) return;
  for (const draft of hold.drafts.keys()) if (draft.isFreed) hold.drafts.delete(draft);
  if (hold.drafts.size === 0) return;
  for (const draft of hold.drafts.keys())
    for (const listener of hold.listeners.get(draft) ?? []) listener.before();
  forwardInto(hold, new Set(changed));
}

export function registerDraft(draft: RoomDocs, publish: PublishWrite): () => void {
  if (!draft.live) throw new Error("registerDraft takes a draft's fork");
  const hold = holdFor(draft);
  hold.drafts.set(draft, publish);
  return () => {
    if (hold.drafts.get(draft) === publish) hold.drafts.delete(draft);
  };
}

function deliver(hold: Hold, docs: RoomDocs, changed: ReadonlySet<DocKey>, remote: boolean) {
  for (const listener of hold.listeners.get(docs) ?? []) listener.after(changed, remote);
}

function composing(hold: Hold): boolean {
  for (const view of hold.views) if (!view.isDestroyed && view.composing) return true;
  return false;
}

export function listenToImports(docs: RoomDocs, listener: EditorListener): () => void {
  const hold = holdFor(docs);
  let set = hold.listeners.get(docs);
  if (!set) {
    set = new Set();
    hold.listeners.set(docs, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) hold.listeners.delete(docs);
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
