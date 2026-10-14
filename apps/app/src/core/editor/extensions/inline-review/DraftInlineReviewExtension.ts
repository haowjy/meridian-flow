/**
 * Draft-only review painting: the browser-computed review (`ProjectedReview`)
 * becomes green marks and red removal widgets. The extension is a passive
 * receiver: the draft's review runtime computes and pushes the frame, and
 * focus, folds, pulses and locale repaint the cached frame. Until the next
 * frame arrives, the painter owns position mapping: the writer's edits are
 * accumulated and mapped through only when a position is read (`currentReview`),
 * so typing never blanks the review and a keystroke does not clone every group.
 * Painting may be newer than the chrome's frame; that never changes what a
 * click on older chrome means. Live editors never install this extension.
 * Removal widgets never enter manuscript content.
 */

import { i18n } from "@lingui/core";
import { type Command, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { DecorationSet, type EditorView } from "@tiptap/pm/view";
import type * as Y from "yjs";
import { CHANGE_ATTR, paintDecorations } from "./decorations";
import { isSameChange, mapReview, type ProjectedReview } from "./model";
import type { RemovalHandlers } from "./removal-widget";

/** The writer's edits since the review was projected, newest first; mapped only when a position is read. */
interface PendingEdits {
  mapping: Mapping;
  doc: PMNode;
  earlier: PendingEdits | null;
}

/** A change the writer applied: its id and pin in the frame they clicked. */
export type AppliedChangeRef = { id: string; pin: Y.RelativePosition };

export interface InlineReviewPluginState {
  /** The review as projected, or null before the first frame and while `review_base` is absent. Read it through `currentReview`. */
  review: ProjectedReview | null;
  /** The edits that moved the text since `review` was projected. */
  edits: PendingEdits | null;
  activeChangeId: string | null;
  /** Changes that just arrived; their marks pulse once. */
  pulsedChangeIds: ReadonlySet<string>;
  /** Changes the writer applied: they stop being painted at the click, before the base patch arrives. Matched by pin and hash, never by id. */
  applied: readonly AppliedChangeRef[];
  /** False hides every mark and removal; the review and selection are kept. */
  marksVisible: boolean;
  /** Identities of long removals the writer has unfolded. */
  expandedRemovals: ReadonlySet<string>;
  /** The focused change's bar has no room in the margin and takes a block after the change. */
  barSlot: boolean;
  /** Full projection, even while hidden. */
  decorations: DecorationSet;
}

type PluginMeta =
  | { kind: "set-review"; review: ProjectedReview | null }
  | { kind: "set-active-change"; changeId: string | null }
  | { kind: "focus-click"; changeId: string }
  | { kind: "set-marks-visible"; visible: boolean }
  | { kind: "set-pulse"; changeIds: readonly string[] }
  | { kind: "set-applied"; applied: readonly AppliedChangeRef[] }
  | { kind: "set-bar-slot"; open: boolean }
  | { kind: "relocalize" }
  | { kind: "removal-click"; changeId: string; toggle: string | null; keyboard: boolean };

const mappedReviews = new WeakMap<PendingEdits, ProjectedReview>();

/** The review at today's positions: one mapping through every edit since the frame, done once per read. */
export function currentReview(state: InlineReviewPluginState): ProjectedReview | null {
  const { review, edits } = state;
  if (!review || !edits) return review;
  let mapped = mappedReviews.get(edits);
  if (!mapped) {
    const mapping = new Mapping();
    const chain: PendingEdits[] = [];
    for (let step: PendingEdits | null = edits; step; step = step.earlier) chain.push(step);
    for (let i = chain.length - 1; i >= 0; i--) mapping.appendMapping(chain[i].mapping);
    mapped = mapReview(review, mapping, edits.doc);
    mappedReviews.set(edits, mapped);
  }
  return mapped;
}

/** Public plugin key so React consumers can read state without holding the extension instance. */
export const draftInlineReviewPluginKey = new PluginKey<InlineReviewPluginState>(
  "meridian:draft-inline-review",
);

/** TipTap command surface: `editor.commands.setReviewProjection(...)` etc. */
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    draftInlineReview: {
      /** Paint this review. Ignored when it was computed on another document than the editor's now. */
      setReviewProjection: (review: ProjectedReview | null) => ReturnType;
      setReviewActiveChange: (changeId: string | null) => ReturnType;
      setReviewMarksVisible: (visible: boolean) => ReturnType;
      /** Mark these changes as just arrived; pass [] to end the pulse. */
      setReviewPulse: (changeIds: readonly string[]) => ReturnType;
      /** Stop painting these changes: the writer applied them and the review has not caught up. */
      setReviewApplied: (applied: readonly AppliedChangeRef[]) => ReturnType;
      /** Open a block after the focused change for its bar, when the margin has no room. */
      setReviewBarSlot: (open: boolean) => ReturnType;
      /** `instant` jumps: for a scroll the editor is about to be replaced under, which must not stop half way. */
      scrollReviewChangeIntoView: (changeId: string, options?: { instant?: boolean }) => ReturnType;
    };
  }
}

export const DraftInlineReviewExtension = Extension.create({
  name: "draftInlineReview",

  addProseMirrorPlugins() {
    return [buildInlineReviewPlugin()];
  },

  addCommands() {
    const command =
      (meta: PluginMeta): Command =>
      ({ tr, dispatch }) => {
        if (dispatch) {
          tr.setMeta(draftInlineReviewPluginKey, meta).setMeta("addToHistory", false);
          dispatch(tr);
        }
        return true;
      };
    return {
      setReviewProjection: (review) => command({ kind: "set-review", review }),
      setReviewActiveChange: (changeId) => command({ kind: "set-active-change", changeId }),
      setReviewMarksVisible: (visible) => command({ kind: "set-marks-visible", visible }),
      setReviewPulse: (changeIds) => command({ kind: "set-pulse", changeIds }),
      setReviewApplied: (applied) => command({ kind: "set-applied", applied }),
      setReviewBarSlot: (open) => command({ kind: "set-bar-slot", open }),
      scrollReviewChangeIntoView:
        (changeId, options) =>
        ({ view }) => {
          // Scroll the manuscript block from the projection, never painted marks or selection.
          const pluginState = draftInlineReviewPluginKey.getState(view.state);
          const review = pluginState && currentReview(pluginState);
          const group = review?.groups.find((candidate) => candidate.id === changeId);
          if (!review || !group) return false;
          const position = Math.min(
            ...group.hunks.map((hunk) => hunk.inserted?.from ?? hunk.anchor),
            view.state.doc.content.size,
          );
          const resolved = view.state.doc.resolve(position);
          const target = view.nodeDOM(resolved.depth > 0 ? resolved.before(1) : position);
          if (!(target instanceof HTMLElement)) return false;
          const reduceMotion =
            typeof window !== "undefined" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          target.scrollIntoView({
            block: "center",
            behavior: reduceMotion || options?.instant ? "auto" : "smooth",
          });
          return true;
        },
    };
  },
});

function dispatchMeta(view: EditorView, meta: PluginMeta): void {
  const tr = view.state.tr;
  tr.setMeta(draftInlineReviewPluginKey, meta);
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
}

/** What a removal widget does on click: it holds the view it was drawn in. */
function removalHandlersFor(view: EditorView): RemovalHandlers {
  return {
    activate: (changeId, toggle, keyboard) =>
      dispatchMeta(view, { kind: "removal-click", changeId, toggle, keyboard }),
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

function paint(state: InlineReviewPluginState, refocusRemoval: string | null = null) {
  const projected = currentReview(state);
  if (!projected) return DecorationSet.empty;
  const { applied } = state;
  const review =
    applied.length === 0
      ? projected
      : {
          ...projected,
          groups: projected.groups.filter(
            (group) =>
              !applied.some((entry) => isSameChange(entry, group.id, projected.pins.get(group.id))),
          ),
        };
  return paintDecorations(
    review,
    {
      activeChangeId: state.activeChangeId,
      pulsedChangeIds: state.pulsedChangeIds,
      expandedRemovals: state.expandedRemovals,
      refocusRemoval,
      barSlot: state.barSlot,
    },
    removalHandlersFor,
  );
}

export function buildInlineReviewPlugin() {
  return new Plugin<InlineReviewPluginState>({
    key: draftInlineReviewPluginKey,
    state: {
      init: () => ({
        review: null,
        edits: null,
        activeChangeId: null,
        pulsedChangeIds: new Set(),
        applied: [],
        marksVisible: true,
        expandedRemovals: new Set(),
        barSlot: false,
        decorations: DecorationSet.empty,
      }),
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(draftInlineReviewPluginKey) as PluginMeta | undefined;
        const next = { ...previous };
        let repaint = false;
        // Every repaint and scroll reads current positions through `currentReview`, so the review follows the
        // text without a keystroke paying to map every change.
        if (tr.docChanged && meta?.kind !== "set-review" && next.review)
          next.edits = { mapping: tr.mapping, doc: newState.doc, earlier: previous.edits };
        let refocusRemoval: string | null = null;
        switch (meta?.kind) {
          case "set-review":
            // A projection of another document would place marks on the wrong text; the next one is coming.
            if (meta.review && meta.review.doc !== newState.doc) return previous;
            next.review = meta.review;
            next.edits = null;
            repaint = true;
            break;
          case "set-active-change":
          case "focus-click":
            next.activeChangeId = meta.changeId;
            repaint = true;
            break;
          case "set-pulse":
            next.pulsedChangeIds = new Set(meta.changeIds);
            repaint = true;
            break;
          case "set-applied":
            next.applied = meta.applied;
            repaint = true;
            break;
          case "set-bar-slot":
            if (meta.open === previous.barSlot) return previous;
            next.barSlot = meta.open;
            repaint = true;
            break;
          case "set-marks-visible":
            next.marksVisible = meta.visible;
            break;
          case "relocalize":
            repaint = true;
            break;
          case "removal-click":
            next.activeChangeId = meta.changeId;
            if (meta.toggle !== null) {
              const expanded = new Set(previous.expandedRemovals);
              if (!expanded.delete(meta.toggle)) expanded.add(meta.toggle);
              next.expandedRemovals = expanded;
              if (meta.keyboard) refocusRemoval = meta.toggle;
            }
            repaint = true;
            break;
        }
        if (repaint) next.decorations = paint(next, refocusRemoval);
        // The writer's edit before the next projection: carry what is painted along with the text.
        else if (tr.docChanged) next.decorations = previous.decorations.map(tr.mapping, tr.doc);
        return next;
      },
    },
    view: (view) => {
      // The fold's label is copy: a locale change redraws it from the same projection.
      const unsubscribe = i18n.on("change", () => dispatchMeta(view, { kind: "relocalize" }));
      return { destroy: unsubscribe };
    },
    props: {
      decorations(state) {
        const pluginState = draftInlineReviewPluginKey.getState(state);
        return pluginState?.marksVisible ? pluginState.decorations : DecorationSet.empty;
      },
      handleDOMEvents: {
        input: (view) => {
          // A repaint can land before the MutationObserver's delivery,
          // overwriting a native input's caret with the previous PM selection.
          // Consume it through PM's own observer (prosemirror-view 1.41.9), not a
          // second DOM parser or a numeric selection repair after the repaint.
          const { domObserver } = view as EditorView & {
            domObserver: { forceFlush(): void; flush(): void };
          };
          domObserver.forceFlush();
          domObserver.flush();
          return false;
        },
        // A click on any mark focuses its change, so surfaces reading plugin
        // state (the stepper, the list rows) can reflect the emphasis.
        mousedown: (view, event) => {
          const target = event.target as HTMLElement | null;
          const changeId = target?.closest?.(`[${CHANGE_ATTR}]`)?.getAttribute(CHANGE_ATTR);
          if (!changeId) return false;
          if (draftInlineReviewPluginKey.getState(view.state)?.activeChangeId === changeId)
            return false;
          dispatchMeta(view, { kind: "focus-click", changeId });
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

/** Only writer input produces a focus intent; projections and programmatic emphasis are output. */
export function inlineReviewFocusIntent(transaction: {
  getMeta: (key: PluginKey) => unknown;
}): string | null {
  const meta = transaction.getMeta(draftInlineReviewPluginKey) as PluginMeta | undefined;
  return meta?.kind === "focus-click" || meta?.kind === "removal-click" ? meta.changeId : null;
}
