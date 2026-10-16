/**
 * The review runtime: one per draft room, however many surfaces read it. It computes the room's review
 * and publishes it as an immutable frame (`ReviewFrame`: diff and groups, the Yjs snapshot, each change's
 * pin) inside a small state (`ReviewState`), and does the work that belongs to the room once: the base
 * blocks are read once per `review_base` change, command records are reconciled against each ready frame,
 * and every mounted editor's painter is handed the frame. The runtime is also the one place that joins
 * the frame with what is not text: who wrote each change and which conversations it belongs to (the classified attribution), and the draft's
 * command records, which it turns into the visible changes and their failures (`review-visible.ts`).
 * Readers select from that state; none of them recomputes it.
 *
 * Two sources, one stream. With no editor the runtime reads the room's Yjs text on a 120 ms trailing
 * debounce (the draft dock and the Work page). With editors attached (`attachEditor`) it projects the first
 * attached editor's state, whose unchanged top-level nodes hit the diff core's node caches: a recompute runs 120 ms after
 * the writer's edits, at once for a peer's write or a `review_base` change, and the previous frame stays
 * painted (mapped through the writer's edits by the painter) until the next is ready.
 *
 * One room computes one frame, but each attachment (a tab, the dock) owns its painter and its command
 * handle: a Discard is authored into the history of the editor it is clicked in, and releasing an
 * attachment removes exactly that one.
 *
 * Nothing here reads React. Surfaces read `reviewStateOf` through `useReviewState`, and a command carries the
 * frame its row was drawn from (`ReviewChange.frame`), never "whatever the runtime holds now".
 */

import { APPLY_RECORD_ROOT, RESTORED_ROOT, REVIEW_BASE_FRAGMENT } from "@meridian/agent-edit/diff";
import type { DraftAttribution } from "@meridian/contracts/drafts";
import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { absolutePositionToRelativePosition } from "@tiptap/y-tiptap";
import {
  currentDraftCommandRecords,
  type DraftRef,
  draftCommandKey,
  reconcileChangeRecords,
  watchDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { draftAttributionQueryOptions } from "@/client/query/useDraftAttribution";
import { isRemoteDocumentRebuild } from "@/core/editor/anchors";
import type { DocumentSession } from "@/core/editor/document-session";
import { sameContent } from "@/core/editor/extensions/inline-review";
import { relativePositionRuntimeFromState } from "@/core/editor/relative-position-runtime";
import type { ReviewEditorHandle } from "./draft-discard";
import { classifyRoom } from "./review-attribution";
import { baseKeyOf, buildFrame, projectRoom, type ReviewFrame, readBase } from "./review-frame";
import { type ReviewChange, reviewChanges } from "./review-model";
import { deriveVisible, NO_VISIBLE, type ReviewVisible } from "./review-visible";

export const REVIEW_DEBOUNCE_MS = 120;

/** What the runtime needs of a draft room: its Yjs document and whether the server has synced it. */
export type ReviewRoom = Pick<
  DocumentSession,
  "document" | "subscribe" | "getSnapshot" | "whenSynced" | "hasUnacknowledgedEdits"
>;

export type ReviewState = ReviewVisible & {
  /** The frame last published, or null while there is nothing to compare. */
  frame: ReviewFrame | null;
  /** The frame's changes with their byline and membership, applied ones included. */
  changes: readonly ReviewChange[];
  /** The room has synced, so an empty frame means "No changes left", not "not loaded yet". */
  ready: boolean;
  /** The payload needed to distinguish unknown membership from a known-empty chat. */
  attributionReady: boolean;
};

/** Where an editor is mounted: the center pane or the dock beside the chat. The phone's one editor is "editor". */
export type ReviewSurface = "editor" | "dock";

/** Names one attached editor: the editor itself, or the surface it is mounted on (for the header outside it). */
export type EditorRef = Editor | ReviewSurface;

/** One attached editor: what the room paints and what a command issued in it is authored through. */
type Attachment = { editor: Editor; surface: ReviewSurface; handle: ReviewEditorHandle };

type Attribution = NonNullable<Parameters<typeof reviewChanges>[1]>;
const NO_ATTRIBUTION: Attribution = new Map();
const NO_EDITS: DraftAttribution | null = null;

export interface ReviewRuntime {
  state(): ReviewState;
  subscribe(listener: () => void): () => void;
  /** Compute now from the current text (the editor's, when one is attached). */
  projectNow(): ReviewFrame | null;
  /** Resolves when the room holds no unsynced local updates: Apply waits for it so the server sees what the writer saw. */
  acknowledged(): Promise<void>;
  /** Paint this editor with the room's frames until the returned detach, which removes only this attachment. */
  attachEditor(editor: Editor, surface?: ReviewSurface): () => void;
  /**
   * The command handle of one attached editor, named by itself or by its surface (null when it is not
   * attached). Without an argument, of the longest-attached editor: only for a list row, which sits in no
   * editor's surface. A control inside an editor's surface names that editor.
   */
  editorHandle(of?: EditorRef): ReviewEditorHandle | null;
  destroy(): void;
}

const NO_CHANGES: readonly ReviewChange[] = [];
const EMPTY: ReviewState = {
  ...NO_VISIBLE,
  frame: null,
  changes: NO_CHANGES,
  ready: false,
  attributionReady: false,
};

/**
 * How long Apply waits for the server to hold the room's local edits. Past it the Apply fails on the change
 * (nothing was sent); it is never sent as if the server had them.
 */
const ACKNOWLEDGE_WAIT_MS = 15_000;

/** The one acknowledgment path of every Apply (and of the draft dock's read of an unopened room). */
export function whenAcknowledged(room: Pick<ReviewRoom, "subscribe" | "hasUnacknowledgedEdits">) {
  if (!room.hasUnacknowledgedEdits()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      unsubscribe();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("The server did not acknowledge the draft's edits"))),
      ACKNOWLEDGE_WAIT_MS,
    );
    unsubscribe = room.subscribe(() => {
      if (!room.hasUnacknowledgedEdits()) finish(resolve);
    });
  });
}

/** What the runtime joins to the room's text: the draft's command records and attribution. */
export type ReviewSource = { draft: DraftRef; queryClient: QueryClient };

/** `source` is null for a runtime nothing sends commands from: it has no records and no attribution. */
export function createReviewRuntime(room: ReviewRoom, source: ReviewSource | null): ReviewRuntime {
  const draft = source?.draft ?? null;
  const yDoc = room.document;
  const listeners = new Set<() => void>();
  let state: ReviewState = EMPTY;
  let edits: DraftAttribution | null = NO_EDITS;
  let provenanceRevision = 0;
  let matched: {
    frame: ReviewFrame;
    edits: DraftAttribution;
    provenanceRevision: number;
    value: Attribution;
  } | null = null;
  let reconciling = false;
  /** The draft's command record the state was derived from. */
  let seenRecord: unknown;
  let revision: string | null = null;
  /** Attached editors in attachment order; the first is the one the room projects from. */
  const attachments: Attachment[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushQueued = false;
  let destroyed = false;
  let synced = room.getSnapshot().status === "synced";
  /** The base blocks, parsed once per schema (an editor's own, or the headless one) until `review_base` changes. */
  let baseBlocks = new Map<Schema | null, PMNode[]>();

  const attributionOf = (frame: ReviewFrame): Attribution => {
    // Until the chats' writes have loaded, a change is not the writer's: nothing is said.
    if (!edits) return NO_ATTRIBUTION;
    if (
      !matched ||
      matched.frame !== frame ||
      matched.edits !== edits ||
      matched.provenanceRevision !== provenanceRevision
    )
      matched = { frame, edits, provenanceRevision, value: classifyRoom(yDoc, frame, edits) };
    return matched.value;
  };

  // The chats' edit parts: one observer per room, asked again when the set of changes moves.
  const attributionQuery = source
    ? new QueryObserver(source.queryClient, {
        ...draftAttributionQueryOptions(source.draft),
        enabled: false,
      })
    : null;
  const useAttribution = (frame: ReviewFrame) => {
    if (!attributionQuery || !source) return;
    const now = frame.groups.map((group) => group.id).join(",");
    const first = revision === null;
    if (revision === now) return;
    revision = now;
    if (first)
      attributionQuery.setOptions({ ...draftAttributionQueryOptions(source.draft), enabled: true });
    else void attributionQuery.refetch();
  };

  /** The frame the attached painters were last handed (state follows it by at most one microtask). */
  let painted: ReviewFrame | null = null;
  let settleQueued = false;
  let settleFrame: ReviewFrame | null = null;
  let settledEdits = edits;
  let settledProvenanceRevision = provenanceRevision;

  /**
   * Hand one editor the room's frame, bound to that editor's own document: the frame's positions address
   * text, and two editors over one room hold equal text in different `PMNode` objects. An editor whose
   * text has not caught up with the frame is skipped; its next transaction schedules the projection it gets.
   */
  const paintAttachment = (editor: Editor, frame: ReviewFrame | null) => {
    if (editor.isDestroyed) return;
    if (!frame || frame.doc === editor.state.doc) {
      editor.commands.setReviewProjection(frame);
      return;
    }
    if (sameContent(frame.doc, editor.state.doc))
      editor.commands.setReviewProjection({ ...frame, doc: editor.state.doc });
  };

  /** Bookkeeping: join the frame with attribution and command records, derive what is visible, tell readers. */
  const settle = (frame: ReviewFrame | null) => {
    const changes =
      frame &&
      frame === state.frame &&
      edits === settledEdits &&
      settledProvenanceRevision === provenanceRevision
        ? state.changes
        : frame
          ? reviewChanges(frame, attributionOf(frame))
          : NO_CHANGES;
    const ready = frame !== null && (synced || changes.length > 0);
    if (ready && frame && draft) {
      reconciling = true;
      try {
        reconcileChangeRecords(
          draft,
          changes.map((change) => ({ id: change.id, pin: change.pin })),
          () => baseKeyOf(frame),
        );
      } finally {
        reconciling = false;
      }
    }
    const record = draft ? currentDraftCommandRecords()[draftCommandKey(draft)] : undefined;
    // Nothing a reader selects from moved: keep the state object, wake no one.
    if (
      frame === state.frame &&
      ready === state.ready &&
      record === seenRecord &&
      edits === settledEdits &&
      settledProvenanceRevision === provenanceRevision
    )
      return;
    seenRecord = record;
    settledEdits = edits;
    settledProvenanceRevision = provenanceRevision;
    const visible =
      frame && draft
        ? deriveVisible(frame, changes, currentDraftCommandRecords(), draft)
        : NO_VISIBLE;
    state = { ...visible, frame, changes, ready, attributionReady: edits !== null };
    if (frame) useAttribution(frame);
    for (const listener of listeners) listener();
  };

  /** The room's latest frame, settled or still waiting to be. */
  const latest = () => (settleQueued ? settleFrame : state.frame);

  /**
   * Two phases. The painters get the frame first, so the writer's mark is on screen before any bookkeeping.
   * `deferred` puts the bookkeeping in a microtask (a typing frame), where it runs after the browser has
   * delivered the paint's DOM mutation; a command that reads the result right away settles at once.
   */
  const publish = (frame: ReviewFrame | null, deferred = false) => {
    if (frame !== painted) {
      painted = frame;
      for (const attachment of attachments) paintAttachment(attachment.editor, frame);
    }
    settleFrame = frame;
    if (!deferred) {
      settleQueued = false;
      settle(frame);
      return;
    }
    if (settleQueued) return;
    settleQueued = true;
    queueMicrotask(() => {
      if (!settleQueued) return;
      settleQueued = false;
      if (!destroyed) settle(settleFrame);
    });
  };

  // The draft's command records change: the visible changes and their failures follow, here, once.
  const unwatchRecords = draft
    ? watchDraftCommandRecords(() => {
        if (reconciling || destroyed || !latest()) return;
        if (currentDraftCommandRecords()[draftCommandKey(draft)] === seenRecord) return;
        publish(latest());
      })
    : () => {};
  const unwatchAttribution = attributionQuery?.subscribe((result) => {
    const next = result.data ?? NO_EDITS;
    if (next === edits) return;
    edits = next;
    if (latest() && !destroyed) publish(latest());
  });
  if (attributionQuery) edits = attributionQuery.getCurrentResult().data ?? NO_EDITS;

  const baseFor = (schema: Schema | null): PMNode[] => {
    let blocks = baseBlocks.get(schema);
    if (!blocks) {
      blocks = schema ? readBase(yDoc, schema) : readBase(yDoc);
      baseBlocks.set(schema, blocks);
    }
    return blocks;
  };

  const projectEditor = (attached: Editor): ReviewFrame | null => {
    const bound = relativePositionRuntimeFromState(attached.state);
    if (!bound) return null;
    const blocks = baseFor(attached.schema);
    return buildFrame(bound.yDoc, blocks, attached.state.doc, (position) =>
      absolutePositionToRelativePosition(position, bound.yFragment, bound.mapping),
    );
  };

  const projectHeadless = (): ReviewFrame => {
    return projectRoom(yDoc, baseFor(null));
  };

  /** Project now from `from` (default the room's own editor, else the room's text) and publish to every painter. */
  const projectNow = (
    from: Editor | null = attachments[0]?.editor ?? null,
    deferred = false,
  ): ReviewFrame | null => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (destroyed) return state.frame;
    if (from?.isDestroyed) return state.frame;
    // A room read without an editor is not read before the server has reconciled it.
    if (!from && !synced) return state.frame;
    const frame = from ? projectEditor(from) : projectHeadless();
    if (!frame) return state.frame;
    publish(frame, deferred);
    return frame;
  };

  /** Several triggers in one tick (a rebase writes many items) collapse to one compute. */
  const flushSoon = () => {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      projectNow();
    });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => projectNow(undefined, true), REVIEW_DEBOUNCE_MS);
  };

  const baseFragment = yDoc.getXmlFragment(REVIEW_BASE_FRAGMENT);
  const onBaseChange = () => {
    baseBlocks = new Map();
    if (attachments.length > 0) flushSoon();
  };
  baseFragment.observeDeep(onBaseChange);

  // Undo's provenance can arrive separately from its prose. Neither it nor Apply's record produces
  // an editor transaction, but both change membership even when the frame/payload stay identical.
  const provenanceRoots = [yDoc.getArray(RESTORED_ROOT), yDoc.getArray(APPLY_RECORD_ROOT)];
  const onProvenanceChange = () => {
    provenanceRevision++;
    // The next row must carry a snapshot containing this evidence too: Apply reconstructs that
    // snapshot on the server, not merely the prose that happens to be unchanged.
    flushSoon();
  };
  for (const root of provenanceRoots) root.observeDeep(onProvenanceChange);

  // Without an editor the room's own updates drive the frame; with one, its transactions do.
  const onUpdate = () => {
    if (attachments.length === 0) schedule();
  };
  yDoc.on("update", onUpdate);
  /** The room's first server reconciliation happened: an empty frame is then "No changes left". Once true, it stays true. */
  const markSynced = () => {
    if (synced || destroyed) return;
    synced = true;
    if (latest()) publish(latest());
    if (attachments.length === 0) flushSoon();
  };
  const unsubscribeRoom = room.subscribe((snapshot) => {
    if (snapshot.status === "synced") markSynced();
  });
  void room.whenSynced().then(markSynced);
  flushSoon();

  const onTransaction = ({
    transaction,
  }: {
    transaction: Parameters<typeof isRemoteDocumentRebuild>[0];
  }) => {
    if (!transaction.docChanged) return;
    if (isRemoteDocumentRebuild(transaction)) flushSoon();
    else schedule();
  };

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    projectNow: () => projectNow(),
    acknowledged: () => whenAcknowledged(room),
    attachEditor(attached, surface = "editor") {
      const attachment: Attachment = {
        editor: attached,
        surface,
        handle: {
          editor: attached,
          current: () => state.frame,
          projectNow: () => projectNow(attached),
        },
      };
      attachments.push(attachment);
      attached.on("transaction", onTransaction);
      // A second editor joins a frame already published: it is painted now, not at the next change.
      paintAttachment(attached, painted);
      flushSoon();
      return () => {
        attached.off("transaction", onTransaction);
        const at = attachments.indexOf(attachment);
        if (at < 0) return;
        attachments.splice(at, 1);
        if (!destroyed) flushSoon();
      };
    },
    editorHandle: (of) =>
      (of
        ? attachments.find((attachment) =>
            typeof of === "string" ? attachment.surface === of : attachment.editor === of,
          )
        : attachments[0]
      )?.handle ?? null,
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      yDoc.off("update", onUpdate);
      unsubscribeRoom();
      unwatchRecords();
      unwatchAttribution?.();
      baseFragment.unobserveDeep(onBaseChange);
      for (const root of provenanceRoots) root.unobserveDeep(onProvenanceChange);
      for (const { editor } of attachments) editor.off("transaction", onTransaction);
      attachments.length = 0;
      listeners.clear();
    },
  };
}

// ---- the registry: one runtime per draft, retained by whoever reads it ----

type Entry = { runtime: ReviewRuntime; room: ReviewRoom; holds: number };
const entries = new Map<string, Entry>();
const watchers = new Map<string, Set<() => void>>();

function announce(key: string): void {
  for (const watcher of watchers.get(key) ?? []) watcher();
}

/** Hold the draft's runtime (creating it with the first holder) until the returned release. */
export function retainReviewRuntime(
  draft: DraftRef,
  room: ReviewRoom,
  queryClient: QueryClient,
): () => void {
  const key = draftCommandKey(draft);
  let entry = entries.get(key);
  if (!entry || entry.room.document !== room.document) {
    const made: Entry = {
      runtime: createReviewRuntime(room, { draft, queryClient }),
      room,
      holds: 0,
    };
    made.runtime.subscribe(() => announce(key));
    entries.set(key, made);
    entry = made;
  }
  const held = entry;
  held.holds += 1;
  announce(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holds -= 1;
    if (held.holds > 0) return;
    held.runtime.destroy();
    if (entries.get(key) === held) entries.delete(key);
    announce(key);
  };
}

/** The draft's runtime while some surface holds it; commands that need the editor or the room's wait use it. */
export function reviewRuntimeOf(draft: DraftRef | null): ReviewRuntime | null {
  return draft ? (entries.get(draftCommandKey(draft))?.runtime ?? null) : null;
}

export function reviewStateOf(key: string): ReviewState {
  return entries.get(key)?.runtime.state() ?? EMPTY;
}

export function watchReviewState(key: string, listener: () => void): () => void {
  const set = watchers.get(key) ?? new Set<() => void>();
  watchers.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && watchers.get(key) === set) watchers.delete(key);
  };
}
