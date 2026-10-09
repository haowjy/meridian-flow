/**
 * DraftInlineReviewExtension — projection-only change marks for the draft
 * review editor, in the manner of suggestion mode.
 *
 * Owns a single `DecorationSet` describing every hunk in the current server
 * review model. Insertions tint content already present in the draft (green
 * for the AI, gold for the writer, dashed grey where the two can't be split);
 * removed live text is a read-only struck-through widget. Marks are decorations
 * only: the plugin never creates manuscript text, so nothing it shows can be
 * typed into or saved.
 *
 * Lifecycle inside the plugin:
 *  - `setInlineReviewModel` command → rebuild the DecorationSet from scratch
 *    (decode `Y.RelativePosition` anchors → absolute positions).
 *  - Remote sync transactions rebuild from relative anchors; local writer
 *    typing maps the existing set through the transaction.
 *  - `setInlineReviewActiveOperation` command → repaint from the resolved
 *    geometry so the focused change picks up the emphasis class. Anchors are
 *    resolved once per model and document: a focus step, a pulse, a fold or a
 *    locale change repaints without resolving a single position again.
 *  - `setInlineReviewMarksVisible(false)` hides every mark (the header's
 *    "Show changes" off) without dropping the model, selection or folds.
 *  - Local typing paints its own inserted range gold at once, so the writer's
 *    words never wait on the preview refetch to look like theirs.
 *
 * The extension is only installed in review mode — live editors never load
 * this code path and pay no per-transaction cost.
 */

import { i18n } from "@lingui/core";
import { captureUndoRestorationClaims } from "@meridian/prosemirror-schema";
import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type * as Y from "yjs";
import { isRemoteDocumentRebuild } from "../../anchors";
import {
  inlineReviewClassNames,
  paintDecorations,
  type ReviewGeometry,
  resolveGeometry,
  resolverFromState,
} from "./decorations";
import type { InlineReviewModel } from "./model";
import type { RemovalHandlers } from "./removal-widget";
import { reviewWriterClient } from "./writer-client";

export interface DraftInlineReviewOptions {
  /** Optional initial model — usually the plugin starts empty and receives the model via command. */
  initialModel: InlineReviewModel | null;
  /** Draft document whose content client rotates across independent changes. */
  document?: Y.Doc;
  adoptDocumentClient?: () => void;
  /** Whether marks start visible. Toggle later with `setInlineReviewMarksVisible`. */
  marksVisible: boolean;
}

/** A decoration DOM node carries operation attribution on `data-review-operations`. */
const OPERATION_ATTR = "data-review-operations";

export interface InlineReviewPluginState {
  model: InlineReviewModel | null;
  activeOperationId: string | null;
  /** Operations of changes that just arrived; their marks pulse once. */
  pulsedOperationIds: ReadonlySet<string>;
  /** False hides every mark and removal; the model and selection are kept. */
  marksVisible: boolean;
  /** Identities of long removals the writer has unfolded. */
  expandedRemovals: ReadonlySet<string>;
  /** The focused change's bar has no room in the margin and takes a block after the change. */
  barSlot: boolean;
  /**
   * The model's anchors resolved in `geometry.doc`, kept until the model or
   * the document changes. Null while the binding cannot resolve anchors yet.
   */
  geometry: ReviewGeometry | null;
  /** Model-derived hunk decorations over the server draft projection. */
  decorations: DecorationSet;
}

type PluginMeta =
  | { kind: "set-model"; model: InlineReviewModel | null }
  | { kind: "set-active-operation"; operationId: string | null }
  | { kind: "set-marks-visible"; visible: boolean }
  | { kind: "set-pulse"; operationIds: readonly string[] }
  | { kind: "set-bar-slot"; open: boolean }
  | { kind: "relocalize" }
  | { kind: "removal-click"; operationId: string; toggle: string | null; keyboard: boolean };

/** Spec flag on the writer's just-typed ranges; the next full rebuild replaces them. */
const OPTIMISTIC_SPEC = "optimisticWriter";

/** Public plugin key so React consumers can read state without holding the extension instance. */
export const draftInlineReviewPluginKey = new PluginKey<InlineReviewPluginState>(
  "meridian:draft-inline-review",
);

/** TipTap command surface — provides `editor.commands.setInlineReviewModel(...)` etc. */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    draftInlineReview: {
      setInlineReviewModel: (model: InlineReviewModel | null) => ReturnType;
      setInlineReviewActiveOperation: (operationId: string | null) => ReturnType;
      setInlineReviewMarksVisible: (visible: boolean) => ReturnType;
      /** Mark these operations' changes as just arrived; pass [] to end the pulse. */
      setInlineReviewPulse: (operationIds: readonly string[]) => ReturnType;
      /** Open a block after the focused change for its bar, when the margin has no room. */
      setInlineReviewBarSlot: (open: boolean) => ReturnType;
      scrollInlineReviewOperationIntoView: (operationId: string) => ReturnType;
    };
  }
}

export const DraftInlineReviewExtension = Extension.create<DraftInlineReviewOptions>({
  name: "draftInlineReview",

  addOptions() {
    return {
      initialModel: null,
      marksVisible: true,
    };
  },

  addProseMirrorPlugins() {
    const { initialModel, marksVisible, document, adoptDocumentClient } = this.options;
    return [buildInlineReviewPlugin({ initialModel, marksVisible, document, adoptDocumentClient })];
  },

  addCommands() {
    return {
      setInlineReviewModel:
        (model) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          tr.setMeta(draftInlineReviewPluginKey, { kind: "set-model", model });
          tr.setMeta("addToHistory", false);
          dispatch(tr);
          return true;
        },
      setInlineReviewActiveOperation:
        (operationId) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          tr.setMeta(draftInlineReviewPluginKey, {
            kind: "set-active-operation",
            operationId,
          });
          tr.setMeta("addToHistory", false);
          dispatch(tr);
          return true;
        },
      setInlineReviewMarksVisible:
        (visible) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          tr.setMeta(draftInlineReviewPluginKey, { kind: "set-marks-visible", visible });
          tr.setMeta("addToHistory", false);
          dispatch(tr);
          return true;
        },
      setInlineReviewPulse:
        (operationIds) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          tr.setMeta(draftInlineReviewPluginKey, { kind: "set-pulse", operationIds });
          tr.setMeta("addToHistory", false);
          dispatch(tr);
          return true;
        },
      setInlineReviewBarSlot:
        (open) =>
        ({ tr, dispatch }) => {
          if (!dispatch) return true;
          tr.setMeta(draftInlineReviewPluginKey, { kind: "set-bar-slot", open });
          tr.setMeta("addToHistory", false);
          dispatch(tr);
          return true;
        },
      scrollInlineReviewOperationIntoView:
        (operationId) =>
        ({ view }) => {
          // Scroll the manuscript block from cached anchors, never painted marks or selection.
          const geometry = draftInlineReviewPluginKey.getState(view.state)?.geometry;
          const hunk = geometry?.hunks.find((hunk) => hunk.operationIds.includes(operationId));
          if (!hunk) return false;
          const position = hunk.marks[0]?.from ?? hunk.end;
          const resolved = view.state.doc.resolve(position);
          const target = view.nodeDOM(resolved.depth > 0 ? resolved.before(1) : position);
          if (!(target instanceof HTMLElement)) return false;
          const reduceMotion =
            typeof window !== "undefined" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
          return true;
        },
    };
  },
});

interface PluginContext {
  initialModel: InlineReviewModel | null;
  /** Draft document whose content client rotates across independent changes. */
  document?: Y.Doc;
  adoptDocumentClient?: () => void;
  marksVisible: boolean;
}

function dispatchMeta(view: EditorView, meta: PluginMeta): void {
  const tr = view.state.tr;
  tr.setMeta(draftInlineReviewPluginKey, meta);
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
}

/** What a removal widget does on click: it holds the view it was drawn in. */
function removalHandlersFor(view: EditorView): RemovalHandlers {
  return {
    activate: (operationId, toggle, keyboard) =>
      dispatchMeta(view, { kind: "removal-click", operationId, toggle, keyboard }),
    placeCaret: (identity, side) => {
      // A read-only review (the phone's body) has no caret to move.
      if (!view.editable) return;
      // The widget stands between two characters (or two blocks); either side
      // of it is that one document position, where the decoration is now.
      const widget = draftInlineReviewPluginKey
        .getState(view.state)
        ?.decorations.find(
          undefined,
          undefined,
          (spec) => typeof spec.key === "string" && spec.key.startsWith(`removal:${identity}:`),
        )[0];
      if (!widget) return;
      const tr = view.state.tr
        .setSelection(Selection.near(view.state.doc.resolve(widget.from), side))
        .scrollIntoView();
      tr.setMeta("addToHistory", false);
      view.dispatch(tr);
      // The press was cancelled to keep focus where it was; the caret now moves, so focus follows.
      view.focus();
    },
  };
}

/**
 * The geometry to paint: the one already resolved when it still belongs to this
 * model and this document, otherwise a fresh resolve. A remote rebuild always
 * re-resolves, since the binding's mapping changes under an unchanged document
 * on its first passes.
 */
function geometryFor(
  model: InlineReviewModel | null,
  previous: ReviewGeometry | null,
  newState: EditorState,
  reresolve: boolean,
): ReviewGeometry | null {
  if (!model) return null;
  if (!reresolve && previous?.model === model && previous.doc === newState.doc) return previous;
  const resolver = resolverFromState(newState);
  return resolver ? resolveGeometry(model, resolver) : null;
}

function paint(
  geometry: ReviewGeometry | null,
  state: InlineReviewPluginState,
  refocusRemoval: string | null = null,
) {
  if (!state.marksVisible || !geometry) return DecorationSet.empty;
  return paintDecorations(
    geometry,
    {
      activeOperationId: state.activeOperationId,
      pulsedOperationIds: state.pulsedOperationIds,
      expandedRemovals: state.expandedRemovals,
      refocusRemoval,
      barSlot: state.barSlot,
    },
    removalHandlersFor,
  );
}

/**
 * Ranges a local transaction inserted, in the new document. Remote Yjs
 * rebuilds never reach here (they re-resolve from the server model instead).
 */
function insertedRanges(tr: Transaction): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  tr.mapping.maps.forEach((map, index) => {
    const later = tr.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      const from = later.map(newStart, 1);
      const to = later.map(newEnd, -1);
      if (to > from) ranges.push({ from, to });
    });
  });
  return ranges;
}

const isOptimistic = (spec: Record<string, unknown>) => spec[OPTIMISTIC_SPEC] === true;

/**
 * Paint what a local transaction inserted as the writer's, one run at a time:
 * a keystroke that touches an earlier optimistic range extends it, so a typed
 * sentence is one decoration rather than one per character.
 */
function withOptimisticWriterRanges(decorations: DecorationSet, tr: Transaction): DecorationSet {
  let next = decorations;
  for (const range of insertedRanges(tr)) {
    let { from, to } = range;
    const touching = next.find(from, to, isOptimistic);
    for (const existing of touching) {
      from = Math.min(from, existing.from);
      to = Math.max(to, existing.to);
    }
    next = next
      .remove(touching)
      .add(tr.doc, [
        Decoration.inline(
          from,
          to,
          { class: inlineReviewClassNames.writer },
          { [OPTIMISTIC_SPEC]: true },
        ),
      ]);
  }
  return next;
}

export function buildInlineReviewPlugin({
  initialModel,
  marksVisible,
  document,
  adoptDocumentClient,
}: PluginContext) {
  const writerClient = document ? reviewWriterClient(document, adoptDocumentClient) : null;
  return new Plugin<InlineReviewPluginState>({
    key: draftInlineReviewPluginKey,
    state: {
      init(_config, state) {
        const initial: InlineReviewPluginState = {
          model: initialModel,
          activeOperationId: null,
          pulsedOperationIds: new Set(),
          marksVisible,
          expandedRemovals: new Set(),
          barSlot: false,
          geometry: null,
          decorations: DecorationSet.empty,
        };
        const geometry = geometryFor(initialModel, null, state, true);
        return { ...initial, geometry, decorations: paint(geometry, initial) };
      },
      apply(tr, previous, oldState, newState) {
        // Accepted PM content transactions precede the binding's Yjs write in
        // view.update. Rotate here, never inside an active Yjs transaction.
        writerClient?.apply(tr, oldState, previous.model, newState);
        const meta = tr.getMeta(draftInlineReviewPluginKey) as PluginMeta | undefined;
        // A remote y-sync transaction is the moment the y-prosemirror binding
        // populates or updates its mapping. Re-resolve from RelativePositions
        // on those. This also handles the initial-mount race where the model
        // can arrive before the binding has any mapping entries at all.
        const ySyncChangeOrigin = isRemoteDocumentRebuild(tr);

        let {
          model,
          activeOperationId,
          marksVisible,
          expandedRemovals,
          pulsedOperationIds,
          barSlot,
        } = previous;
        let mustRebuild = false;
        let keepOptimistic = true;
        let refocusRemoval: string | null = null;

        if (meta?.kind === "set-model") {
          model = meta.model;
          mustRebuild = true;
          // The refetched model already attributes what the writer typed.
          keepOptimistic = false;
        } else if (meta?.kind === "set-active-operation") {
          activeOperationId = meta.operationId;
          mustRebuild = true;
        } else if (meta?.kind === "set-pulse") {
          pulsedOperationIds = new Set(meta.operationIds);
          mustRebuild = true;
        } else if (meta?.kind === "set-bar-slot") {
          if (meta.open === barSlot) return previous;
          barSlot = meta.open;
          mustRebuild = true;
        } else if (meta?.kind === "relocalize") {
          mustRebuild = true;
        } else if (meta?.kind === "set-marks-visible") {
          marksVisible = meta.visible;
          mustRebuild = true;
        } else if (meta?.kind === "removal-click") {
          activeOperationId = meta.operationId;
          if (meta.toggle !== null) {
            const next = new Set(expandedRemovals);
            if (!next.delete(meta.toggle)) next.add(meta.toggle);
            expandedRemovals = next;
            if (meta.keyboard) refocusRemoval = meta.toggle;
          }
          mustRebuild = true;
        } else if (ySyncChangeOrigin && model) {
          // Remote edit or first binding pass — re-anchor from
          // RelativePositions so we don't drift on the initial sync frame
          // or on concurrent AI/collab writes.
          mustRebuild = true;
        }

        const next: InlineReviewPluginState = {
          model,
          activeOperationId,
          pulsedOperationIds,
          marksVisible,
          expandedRemovals,
          barSlot,
          geometry: previous.geometry,
          decorations: previous.decorations,
        };
        if (mustRebuild) {
          next.geometry = geometryFor(model, previous.geometry, newState, ySyncChangeOrigin);
          let rebuilt = paint(next.geometry, next, refocusRemoval);
          if (keepOptimistic && marksVisible) {
            const typed = previous.decorations
              .map(tr.mapping, tr.doc)
              .find(undefined, undefined, isOptimistic);
            rebuilt = rebuilt.add(tr.doc, typed);
          }
          next.decorations = rebuilt;
        } else if (tr.docChanged) {
          // Local edits: map existing decoration positions through the
          // transaction. Cheap; positions stay stable through typing bursts.
          const mapped = previous.decorations.map(tr.mapping, tr.doc);
          next.decorations =
            marksVisible && !ySyncChangeOrigin ? withOptimisticWriterRanges(mapped, tr) : mapped;
        }
        return next;
      },
    },
    // Collaboration's view updates first (registered before review). Only then
    // can relative positions address the writer's newly allocated Yjs items.
    view: (view) => {
      const detach = document && captureUndoRestorationClaims(document);
      // The fold's label is copy: a locale change redraws it from the same geometry.
      const unsubscribe = i18n.on("change", () => dispatchMeta(view, { kind: "relocalize" }));
      return {
        update: (view) => writerClient?.capture(view.state),
        destroy: () => {
          unsubscribe();
          detach?.();
        },
      };
    },
    props: {
      decorations(state) {
        const pluginState = draftInlineReviewPluginKey.getState(state);
        return pluginState?.decorations ?? DecorationSet.empty;
      },
      // Editor-side click seam. A click on any hunk decoration DOM adopts its
      // first-listed operation as the active one — surfaces reading plugin
      // state (the dock Changes rows) can reflect the emphasis.
      handleDOMEvents: {
        mousedown: (view, event) => {
          const target = event.target as HTMLElement | null;
          const hit = target?.closest?.(`[${OPERATION_ATTR}]`);
          if (!hit) return false;
          const raw = hit.getAttribute(OPERATION_ATTR);
          const [operationId] = (raw ?? "").split(" ").filter(Boolean);
          if (!operationId) return false;
          const current = draftInlineReviewPluginKey.getState(view.state)?.activeOperationId;
          if (current === operationId) return false;
          const tr = view.state.tr;
          tr.setMeta(draftInlineReviewPluginKey, {
            kind: "set-active-operation",
            operationId,
          });
          tr.setMeta("addToHistory", false);
          view.dispatch(tr);
          // Do not swallow the event; the browser still owns normal focus.
          return false;
        },
      },
    },
  });
}

/** Utility to read the current plugin state from any EditorState. */
export function getInlineReviewPluginState(state: EditorState): InlineReviewPluginState | null {
  return draftInlineReviewPluginKey.getState(state) ?? null;
}
