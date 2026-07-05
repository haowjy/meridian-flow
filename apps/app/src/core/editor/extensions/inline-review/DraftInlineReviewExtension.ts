/**
 * DraftInlineReviewExtension — the writer's Track-Changes surface on the
 * draft editor.
 *
 * Owns a single `DecorationSet` describing every hunk in the current server
 * review model: `Decoration.inline` for text insertions, `Decoration.node`
 * for whole-block insertions, `Decoration.widget` for deletions (inline span
 * or full-width block stand-in). The plugin is the single owner of decoration
 * state; React only talks to it through TipTap commands and read-only plugin
 * state.
 *
 * Lifecycle inside the plugin:
 *  - `setInlineReviewModel` command → rebuild the DecorationSet from scratch
 *    (decode `Y.RelativePosition` anchors → absolute positions).
 *  - Any doc-changing transaction → `DecorationSet.map` to keep positions
 *    stable through local typing without re-decoding.
 *  - `setInlineReviewActiveOperation` command → rebuild in place so the
 *    focused operation picks up the emphasis class.
 *
 * The extension is only installed in review mode — live editors never load
 * this code path and pay no per-transaction cost.
 */
import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

import { buildDecorations, resolverFromState } from "./decorations";
import type { InlineReviewModel } from "./model";

/** Class name shared with `decorations.ts` so optimistic writer overlays
 *  paint in the same gold as the model-derived ones. Kept in sync with
 *  `inlineReviewClassNames.writer` — the CSS lives in editor.css. */
const OPTIMISTIC_WRITER_CLASS = "meridian-review-writer meridian-review-writer-optimistic";

export interface DraftInlineReviewOptions {
  /** Optional initial model — usually the plugin starts empty and receives the model via command. */
  initialModel: InlineReviewModel | null;
}

export const HUNK_REJECT_ORIGIN = Symbol("meridian:hunk-reject");

/** A decoration DOM node carries operation attribution on `data-review-operations`. */
const OPERATION_ATTR = "data-review-operations";

/**
 * Escape an operation id for use in an attribute selector. `CSS.escape` is the
 * browser primitive, but jsdom/Node test environments don't always expose a
 * global `CSS`, so fall back to escaping the CSS special characters by hand —
 * enough for the command to run (and be testable) outside a real browser.
 */
const escapeCssIdent: (value: string) => string =
  globalThis.CSS?.escape ?? ((value) => value.replace(/[^\w-]/g, (ch) => `\\${ch}`));

/** Minimal open interval; source-of-truth for optimistic writer highlighting. */
interface OptimisticRange {
  from: number;
  to: number;
}

export interface InlineReviewPluginState {
  model: InlineReviewModel | null;
  activeOperationId: string | null;
  /** Model-derived hunk decorations. Also merged with `optimisticDecorations`
   *  when the plugin exposes decorations to ProseMirror. */
  decorations: DecorationSet;
  /**
   * Coalesced ranges the writer just typed. Kept as intervals (not a raw
   * `DecorationSet`) so we can union + merge overlapping/adjacent ranges
   * on every transaction — otherwise per-keystroke transactions would
   * stack one decoration per character and render as tiles. Cleared on
   * every `set-model` command; the refreshed model is authoritative.
   */
  optimisticRanges: OptimisticRange[];
  /** Derived from `optimisticRanges`; cached so `props.decorations` doesn't
   *  rebuild the set on every read. */
  optimisticDecorations: DecorationSet;
}

type PluginMeta =
  | { kind: "set-model"; model: InlineReviewModel | null }
  | { kind: "set-active-operation"; operationId: string | null };

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
      scrollInlineReviewOperationIntoView: (operationId: string) => ReturnType;
    };
  }
}

export const DraftInlineReviewExtension = Extension.create<DraftInlineReviewOptions>({
  name: "draftInlineReview",

  addOptions() {
    return {
      initialModel: null,
    };
  },

  addProseMirrorPlugins() {
    const { initialModel } = this.options;
    return [buildInlineReviewPlugin({ initialModel })];
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
      scrollInlineReviewOperationIntoView:
        (operationId) =>
        ({ view }) => {
          // DOM scroll, not selection scroll. The selection route
          // (`TextSelection.near` + `tr.scrollIntoView`) proved unreliable
          // live: it depended on one specific hunk's anchor decoding this
          // pass and on the view honoring a selection move in a review doc.
          // The decorated spans already carry their operation ids as a
          // space-separated DOM attribute, so target the first one in
          // document order directly.
          const target = view.dom.querySelector(
            `[data-review-operations~="${escapeCssIdent(operationId)}"]`,
          );
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
}

export function buildInlineReviewPlugin({ initialModel }: PluginContext) {
  return new Plugin<InlineReviewPluginState>({
    key: draftInlineReviewPluginKey,
    state: {
      init(_config, state) {
        const resolver = resolverFromState(state);
        return {
          model: initialModel,
          activeOperationId: null,
          decorations: resolver
            ? buildDecorations(initialModel, null, resolver)
            : DecorationSet.empty,
          optimisticRanges: [],
          optimisticDecorations: DecorationSet.empty,
        };
      },
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(draftInlineReviewPluginKey) as PluginMeta | undefined;
        // Remote y-sync transactions carry `isChangeOrigin: true` — they're
        // the moments the y-prosemirror binding populates or updates its
        // mapping. Re-resolve from RelativePositions on those; local user
        // typing keeps the cheap `DecorationSet.map` path. This also handles
        // the initial-mount race where the model can arrive before the
        // binding has any mapping entries at all.
        const ySyncChangeOrigin =
          (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
            ?.isChangeOrigin === true;

        let model = previous.model;
        let activeOperationId = previous.activeOperationId;
        let mustRebuild = false;
        // The server-refreshed model owns writer attribution; clearing the
        // optimistic overlay when a new model lands means gold spans get
        // handed off from the overlay to the model's own writer spans as
        // soon as the debounced refetch completes.
        let clearOptimistic = false;

        if (meta?.kind === "set-model") {
          model = meta.model;
          mustRebuild = true;
          clearOptimistic = true;
        } else if (meta?.kind === "set-active-operation") {
          activeOperationId = meta.operationId;
          mustRebuild = true;
        } else if (ySyncChangeOrigin && model) {
          // Remote edit or first binding pass — re-anchor from
          // RelativePositions so we don't drift on the initial sync frame
          // or on concurrent AI/collab writes.
          mustRebuild = true;
        }

        let decorations = previous.decorations;
        if (mustRebuild) {
          const resolver = resolverFromState(newState);
          decorations = resolver
            ? buildDecorations(model, activeOperationId, resolver)
            : DecorationSet.empty;
        } else if (tr.docChanged) {
          // Local edits: map existing decoration positions through the
          // transaction. Cheap; positions stay stable through typing bursts.
          decorations = previous.decorations.map(tr.mapping, tr.doc);
        }

        let optimisticRanges = clearOptimistic
          ? []
          : tr.docChanged
            ? mapOptimisticRanges(previous.optimisticRanges, tr, newState.doc.content.size)
            : previous.optimisticRanges;

        // Only tag insertions from local writer transactions. Remote y-sync
        // (`isChangeOrigin: true`) covers both the reject-driven inverse
        // (`HUNK_REJECT_ORIGIN`) and any collab peer edit — neither belongs
        // to the writer at this editor. `addToHistory === false` transactions
        // are our own model/active-op refreshes; skip those too.
        const isSystemTransaction = tr.getMeta("addToHistory") === false;
        if (tr.docChanged && !ySyncChangeOrigin && !isSystemTransaction && !clearOptimistic) {
          const inserted = collectInsertedRanges(tr);
          if (inserted.length > 0) {
            optimisticRanges = coalesceRanges([...optimisticRanges, ...inserted]);
          }
        }

        const optimisticDecorations =
          optimisticRanges === previous.optimisticRanges && !clearOptimistic
            ? previous.optimisticDecorations
            : rebuildOptimisticDecorations(newState.doc, optimisticRanges);

        return {
          model,
          activeOperationId,
          decorations,
          optimisticRanges,
          optimisticDecorations,
        };
      },
    },
    props: {
      decorations(state) {
        const pluginState = draftInlineReviewPluginKey.getState(state);
        if (!pluginState) return DecorationSet.empty;
        // Model decorations paint colored spans from the server; overlay
        // paints the writer's just-typed characters gold on the same DOM.
        // Adding to the model set (rather than the empty set) keeps the
        // model decorations authoritative on any overlap after mapping —
        // the overlay is a decorative hint, not a source of truth.
        const optimistic = pluginState.optimisticDecorations.find();
        if (optimistic.length === 0) return pluginState.decorations;
        return pluginState.decorations.add(state.doc, optimistic);
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
          // Do not swallow the event — the writer's caret placement is expected
          // behaviour for a click inside real editable text.
          return false;
        },
      },
    },
  });
}

/**
 * Sort and merge a list of ranges so adjacent (touching) or overlapping
 * intervals collapse into one. Adjacent-merge is what keeps per-keystroke
 * transactions from rendering as scrabble tiles — each keystroke arrives
 * as its own `{from, to}` and needs to be unioned with its neighbours
 * before we build decorations. `to === next.from` counts as adjacent.
 * Exported for unit tests; runtime callers stay inside this module.
 */
export function coalesceRanges(ranges: readonly OptimisticRange[]): OptimisticRange[] {
  const valid = ranges.filter((r) => r.to > r.from);
  if (valid.length <= 1) return valid.slice();
  const sorted = valid.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: OptimisticRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/**
 * Map optimistic ranges through a transaction and clamp them to the new
 * doc bounds. Ranges that collapse (e.g. their entire span was deleted)
 * are dropped.
 */
function mapOptimisticRanges(
  ranges: readonly OptimisticRange[],
  tr: Transaction,
  maxPos: number,
): OptimisticRange[] {
  if (ranges.length === 0) return [];
  const mapped: OptimisticRange[] = [];
  for (const range of ranges) {
    const from = Math.min(Math.max(0, tr.mapping.map(range.from, 1)), maxPos);
    const to = Math.min(Math.max(0, tr.mapping.map(range.to, -1)), maxPos);
    if (to > from) mapped.push({ from, to });
  }
  return coalesceRanges(mapped);
}

/**
 * Build the DecorationSet from coalesced ranges. `DecorationSet.create`
 * is authoritative on the new doc — safer than incremental `add` when the
 * previous set was mapped through a transaction that may have collapsed
 * spans.
 */
function rebuildOptimisticDecorations(
  doc: import("@tiptap/pm/model").Node,
  ranges: readonly OptimisticRange[],
): DecorationSet {
  if (ranges.length === 0) return DecorationSet.empty;
  const decorations = ranges.map((range) =>
    Decoration.inline(range.from, range.to, {
      class: OPTIMISTIC_WRITER_CLASS,
      "data-review-optimistic": "true",
    }),
  );
  return DecorationSet.create(doc, decorations);
}

/**
 * Walk a transaction's steps and return the ranges (in the final doc's
 * coordinates) that received newly-inserted content. Used by the optimistic
 * writer overlay so gold decorations map through the same transaction that
 * created the text they cover.
 */
function collectInsertedRanges(tr: Transaction): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (let stepIndex = 0; stepIndex < tr.steps.length; stepIndex += 1) {
    const stepMap = tr.steps[stepIndex]?.getMap();
    if (!stepMap) continue;
    // A later mapping accounts for steps that follow this one in the same
    // transaction so ranges land in the final doc's coordinates.
    const remap = tr.mapping.slice(stepIndex + 1);
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      const from = remap.map(newStart, 1);
      const to = remap.map(newEnd, -1);
      if (to > from) ranges.push({ from, to });
    });
  }
  return ranges;
}

/** Utility to read the current plugin state from any EditorState. */
export function getInlineReviewPluginState(state: EditorState): InlineReviewPluginState | null {
  return draftInlineReviewPluginKey.getState(state) ?? null;
}
