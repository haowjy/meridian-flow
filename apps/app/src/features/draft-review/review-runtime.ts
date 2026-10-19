/** One projection per held draft room. Text decides the groups; base and attribution providers are overlays. */
import { REVIEW_BASE_FRAGMENT } from "@meridian/agent-edit/diff";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import type * as Y from "yjs";
import { isRemoteDocumentRebuild } from "@/core/editor/anchors";
import type { DocumentSession } from "@/core/editor/document-session";
import { sameContent } from "@/core/editor/extensions/inline-review";
import { relativePositionRuntimeFromState } from "@/core/editor/relative-position-runtime";
import {
  adoptRoomEditor,
  buildFrame,
  projectRoom,
  type ReviewFrame,
  readBase,
  roomContent,
} from "./review-frame";
import { type ChangeAttribution, type ReviewChange, reviewChanges } from "./review-model";

export const REVIEW_DEBOUNCE_MS = 120;
export type ReviewRoom = Pick<DocumentSession, "document" | "subscribe" | "getSnapshot">;
export type ReviewSurface = "editor" | "dock";
/** The command owner folds its queue here. Called only after base/provider invalidation, never per keystroke. */
export type ReviewBaseProvider = (room: ReviewRoom, schema: Schema) => readonly PMNode[];
/** B3c supplies names and membership independently of text grouping. */
export type ReviewAttributionProvider = (
  frame: ReviewFrame,
) => ReadonlyMap<string, ChangeAttribution>;
export type ReviewState = {
  frame: ReviewFrame | null;
  changes: readonly ReviewChange[];
  ready: boolean;
};
export const EMPTY_REVIEW_STATE: ReviewState = { frame: null, changes: [], ready: false };
export interface ReviewRuntime {
  state(): ReviewState;
  subscribe(listener: () => void): () => void;
  projectNow(): ReviewFrame | null;
  setBaseProvider(provider: ReviewBaseProvider): void;
  invalidateBase(): void;
  setAttributionProvider(provider: ReviewAttributionProvider): void;
  attachEditor(editor: Editor, surface?: ReviewSurface): () => void;
  editor(of?: Editor | ReviewSurface): Editor | null;
  destroy(): void;
}
const committedBase: ReviewBaseProvider = (room, schema) => readBase(room.document, schema);

export function createReviewRuntime(
  room: ReviewRoom,
  baseOf: ReviewBaseProvider = committedBase,
): ReviewRuntime {
  const yDoc = room.document;
  const listeners = new Set<() => void>();
  const attachments: { editor: Editor; surface: ReviewSurface }[] = [];
  let state = EMPTY_REVIEW_STATE;
  let baseBlocks = new WeakMap<Schema, readonly PMNode[]>();
  let headlessSchema: Schema | undefined;
  let attributionOf: ReviewAttributionProvider = () => new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued = false;
  let destroyed = false;
  let remoteArrival = false;
  let arrivalSequence = 0;
  let synced = room.getSnapshot().status === "synced";
  const baseFor = (schema: Schema) => {
    let blocks = baseBlocks.get(schema);
    if (!blocks) {
      blocks = baseOf(room, schema);
      baseBlocks.set(schema, blocks);
    }
    return blocks;
  };
  const publish = (frame: ReviewFrame | null) => {
    for (const { editor } of attachments) {
      if (editor.isDestroyed) continue;
      // Each editor owns its positions. Another binding can have equal prose with different schema objects.
      if (!frame || frame.doc === editor.state.doc) editor.commands.setReviewProjection(frame);
      else if (sameContent(frame.doc, editor.state.doc))
        editor.commands.setReviewProjection({ ...frame, doc: editor.state.doc });
    }
    const previous = new Map(state.changes.map((change) => [change.id, change]));
    const sequence = remoteArrival && state.frame ? ++arrivalSequence : undefined;
    const changes = (frame ? reviewChanges(frame, attributionOf(frame)) : []).map((change) => ({
      ...change,
      arrival:
        previous.get(change.id)?.arrival ?? (!previous.has(change.id) ? sequence : undefined),
    }));
    remoteArrival = false;
    state = {
      frame,
      changes,
      ready: synced && frame !== null,
    };
    for (const listener of listeners) listener();
  };
  const projectNow = (): ReviewFrame | null => {
    clearTimeout(timer);
    timer = undefined;
    if (destroyed) return state.frame;
    const attached = attachments[0]?.editor;
    if (attached && !attached.isDestroyed) {
      const bound = relativePositionRuntimeFromState(attached.state);
      if (!bound || bound.yDoc !== yDoc) return state.frame;
      const frame = buildFrame(yDoc, baseFor(attached.schema), attached.state.doc);
      publish(frame);
    } else {
      // Headless frames may paint cached content before sync, but ready never authorizes commands then.
      headlessSchema ??= roomContent(yDoc).doc.type.schema;
      const frame = projectRoom(yDoc, baseFor(headlessSchema));
      headlessSchema = frame.doc.type.schema;
      publish(frame);
    }
    return state.frame;
  };
  const flushSoon = () => {
    if (queued || destroyed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!destroyed) projectNow();
    });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(projectNow, REVIEW_DEBOUNCE_MS);
  };
  const invalidateBase = () => {
    baseBlocks = new WeakMap();
    flushSoon();
  };
  const fragment = yDoc.getXmlFragment(REVIEW_BASE_FRAGMENT);
  fragment.observeDeep(invalidateBase);
  const onUpdate = (
    _update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ) => {
    if (!transaction.local) remoteArrival = true;
    if (attachments.length) return;
    if (transaction.local) schedule();
    else flushSoon();
  };
  yDoc.on("update", onUpdate);
  const unsubscribe = room.subscribe((snapshot) => {
    if (snapshot.status === "synced" && !synced) {
      synced = true;
      flushSoon();
    }
  });
  const onTransaction = ({
    transaction,
  }: {
    transaction: Parameters<typeof isRemoteDocumentRebuild>[0];
  }) => {
    if (!transaction.docChanged) return;
    if (isRemoteDocumentRebuild(transaction)) flushSoon();
    else schedule();
  };
  flushSoon();
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    projectNow,
    setBaseProvider(provider) {
      baseOf = provider;
      invalidateBase();
    },
    invalidateBase,
    setAttributionProvider(provider) {
      attributionOf = provider;
      publish(state.frame);
    },
    attachEditor(editor, surface = "editor") {
      const attachment = { editor, surface };
      attachments.push(attachment);
      editor.on("transaction", onTransaction);
      const bound = relativePositionRuntimeFromState(editor.state);
      if (bound) {
        adoptRoomEditor(yDoc, editor.state.doc, bound.mapping);
        headlessSchema = editor.schema;
      }
      projectNow();
      return () => {
        editor.off("transaction", onTransaction);
        const at = attachments.indexOf(attachment);
        if (at >= 0) attachments.splice(at, 1);
        flushSoon();
      };
    },
    editor: (of) =>
      (of
        ? attachments.find((entry) =>
            typeof of === "string" ? entry.surface === of : entry.editor === of,
          )
        : attachments[0]
      )?.editor ?? null,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      unsubscribe();
      yDoc.off("update", onUpdate);
      fragment.unobserveDeep(invalidateBase);
      for (const { editor } of attachments) editor.off("transaction", onTransaction);
      attachments.length = 0;
      listeners.clear();
    },
  };
}

// The room object, not its address, fences teardown/account replacement. All surfaces holding it share a runtime.
const entries = new WeakMap<ReviewRoom, { runtime: ReviewRuntime; holds: number }>();
export function retainReviewRuntime(room: ReviewRoom): {
  runtime: ReviewRuntime;
  release: () => void;
} {
  let entry = entries.get(room);
  if (!entry) {
    entry = { runtime: createReviewRuntime(room), holds: 0 };
    entries.set(room, entry);
  }
  entry.holds++;
  const held = entry;
  let released = false;
  return {
    runtime: held.runtime,
    release() {
      if (released) return;
      released = true;
      if (--held.holds === 0) {
        held.runtime.destroy();
        entries.delete(room);
      }
    },
  };
}
