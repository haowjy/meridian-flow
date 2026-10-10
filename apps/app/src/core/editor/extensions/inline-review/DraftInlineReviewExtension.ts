/**
 * Draft-only review projection: model geometry plus a pending writer overlay.
 * Local insertions paint gold before the Yjs binding writes; view.update then
 * captures their relative anchors. Rebuilds resolve those identities, never
 * mapped decorations. Only explicit writer coverage in a model refresh retires
 * pending text. Visibility gates output without changing attribution.
 * Focus, folds, pulses and locale repaint cached model geometry; live editors
 * never install this extension. Removal widgets never enter manuscript content.
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
  relativePositionForIndex,
  relativePositionRuntimeFromState,
  resolveRelativeRange,
} from "../../relative-position-runtime";
import {
  inlineReviewClassNames,
  paintDecorations,
  type ReviewGeometry,
  resolveGeometry,
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
  pendingWriterRanges: PendingWriterRange[];
  /** Full projection, including pending writer attribution, even while hidden. */
  decorations: DecorationSet;
}

type Range = { from: number; to: number };
type PendingWriterRange = Range & {
  anchors: { start: Y.RelativePosition; end: Y.RelativePosition } | null;
};

type PluginMeta =
  | { kind: "capture-writer"; ranges: PendingWriterRange[] }
  | { kind: "set-model"; model: InlineReviewModel | null }
  | { kind: "set-active-operation"; operationId: string | null }
  | { kind: "set-marks-visible"; visible: boolean }
  | { kind: "set-pulse"; operationIds: readonly string[] }
  | { kind: "set-bar-slot"; open: boolean }
  | { kind: "relocalize" }
  | { kind: "removal-click"; operationId: string; toggle: string | null; keyboard: boolean };

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
  const resolver = relativePositionRuntimeFromState(newState);
  return resolver ? resolveGeometry(model, resolver) : null;
}

function paint(
  geometry: ReviewGeometry | null,
  state: InlineReviewPluginState,
  refocusRemoval: string | null = null,
) {
  if (!geometry) return DecorationSet.empty;
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

/** Subtract only explicit writer coverage; stale and partial receipts leave the rest pending. */
function uncovered(ranges: Range[], coverage: Range[]): Range[] {
  return coverage.reduce(
    (remaining, cover) =>
      remaining.flatMap((range) => {
        if (cover.to <= range.from || cover.from >= range.to) return [range];
        return [
          ...(cover.from > range.from ? [{ from: range.from, to: cover.from }] : []),
          ...(cover.to < range.to ? [{ from: cover.to, to: range.to }] : []),
        ];
      }),
    ranges,
  );
}

function coalesced(ranges: (Range & Partial<PendingWriterRange>)[]): PendingWriterRange[] {
  const result: PendingWriterRange[] = [];
  for (const range of ranges.sort((a, b) => a.from - b.from)) {
    if (range.to <= range.from) continue;
    const last = result.at(-1);
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
      last.anchors = null;
    } else result.push({ anchors: null, ...range });
  }
  return result;
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
          pendingWriterRanges: [],
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
        let pendingWriterRanges = previous.pendingWriterRanges;
        let refocusRemoval: string | null = null;

        if (meta?.kind === "set-model") {
          model = meta.model;
          mustRebuild = true;
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
        } else if (meta?.kind === "removal-click") {
          activeOperationId = meta.operationId;
          if (meta.toggle !== null) {
            const next = new Set(expandedRemovals);
            if (!next.delete(meta.toggle)) next.add(meta.toggle);
            expandedRemovals = next;
            if (meta.keyboard) refocusRemoval = meta.toggle;
          }
          mustRebuild = true;
        } else if (meta?.kind === "capture-writer") {
          pendingWriterRanges = meta.ranges;
          mustRebuild = true;
        } else if (ySyncChangeOrigin) {
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
          pendingWriterRanges,
          geometry: previous.geometry,
          decorations: previous.decorations,
        };
        const runtime = relativePositionRuntimeFromState(newState);
        if (mustRebuild && runtime) {
          next.pendingWriterRanges = coalesced(
            pendingWriterRanges.flatMap((range) => {
              const resolved = range.anchors && resolveRelativeRange(runtime, range.anchors);
              return !resolved
                ? [range]
                : resolved.to > resolved.from
                  ? [{ ...range, ...resolved }]
                  : [];
            }),
          );
        } else if (tr.docChanged) {
          next.pendingWriterRanges = coalesced([
            ...pendingWriterRanges.map((range) => ({
              from: tr.mapping.map(range.from, 1),
              to: tr.mapping.map(range.to, -1),
            })),
            ...insertedRanges(tr),
          ]);
        }
        if (mustRebuild) {
          next.geometry = geometryFor(
            model,
            previous.geometry,
            newState,
            ySyncChangeOrigin || meta?.kind === "capture-writer",
          );
          if (meta?.kind === "set-model") {
            const coverage =
              next.geometry?.hunks.flatMap((hunk) =>
                hunk.marks.filter((mark) => mark.tone === "writer"),
              ) ?? [];
            next.pendingWriterRanges = coalesced(uncovered(next.pendingWriterRanges, coverage));
          }
          next.decorations = paint(next.geometry, next, refocusRemoval);
        } else if (tr.docChanged) {
          // Before the binding writes, map only the model's painted projection.
          next.decorations = paint(previous.geometry, next).map(tr.mapping, tr.doc);
        }
        if (mustRebuild || tr.docChanged) {
          next.decorations = next.decorations.add(
            tr.doc,
            next.pendingWriterRanges.map(({ from, to }) =>
              Decoration.inline(
                from,
                to,
                { class: inlineReviewClassNames.writer },
                { optimisticWriter: true },
              ),
            ),
          );
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
        update: (view) => {
          writerClient?.capture(view.state);
          const state = draftInlineReviewPluginKey.getState(view.state);
          const ranges = state?.pendingWriterRanges;
          const runtime = relativePositionRuntimeFromState(view.state);
          if (
            !runtime ||
            !ranges ||
            (!ranges.some((range) => !range.anchors) &&
              (!state?.geometry || state.geometry.doc === view.state.doc))
          )
            return;
          const captured = ranges.map((range) => {
            const start = relativePositionForIndex(runtime, range.from);
            const end = relativePositionForIndex(runtime, range.to);
            return { ...range, anchors: start && end ? { start, end } : null };
          });
          if (captured.every((range) => range.anchors))
            dispatchMeta(view, { kind: "capture-writer", ranges: captured });
        },
        destroy: () => {
          unsubscribe();
          detach?.();
        },
      };
    },
    props: {
      decorations(state) {
        const pluginState = draftInlineReviewPluginKey.getState(state);
        return pluginState?.marksVisible ? pluginState.decorations : DecorationSet.empty;
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
