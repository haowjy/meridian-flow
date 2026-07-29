/**
 * DraftInlineReviewExtension — projection-only change highlighting for the
 * draft review editor.
 *
 * Owns a single `DecorationSet` describing every hunk in the current server
 * review model. Insertions tint content already present in the server draft;
 * zero-content widgets only anchor deletion-card navigation. The plugin never
 * creates manuscript text.
 *
 * Lifecycle inside the plugin:
 *  - `setInlineReviewModel` command → rebuild the DecorationSet from scratch
 *    (decode `Y.RelativePosition` anchors → absolute positions).
 *  - Remote sync transactions rebuild from relative anchors; local writer
 *    typing maps the existing set through the transaction.
 *  - `setInlineReviewActiveOperation` command → rebuild in place so the
 *    focused operation picks up the emphasis class.
 *
 * The extension is only installed in review mode — live editors never load
 * this code path and pay no per-transaction cost.
 */
import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";

import { escapeCssIdent } from "@/lib/css-selector";

import { isRemoteDocumentRebuild } from "../../anchors";
import { buildDecorations, resolverFromState } from "./decorations";
import type { InlineReviewModel } from "./model";

export interface DraftInlineReviewOptions {
  /** Optional initial model — usually the plugin starts empty and receives the model via command. */
  initialModel: InlineReviewModel | null;
}

/** A decoration DOM node carries operation attribution on `data-review-operations`. */
const OPERATION_ATTR = "data-review-operations";

export interface InlineReviewPluginState {
  model: InlineReviewModel | null;
  activeOperationId: string | null;
  /** Model-derived hunk decorations over the server draft projection. */
  decorations: DecorationSet;
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
        };
      },
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(draftInlineReviewPluginKey) as PluginMeta | undefined;
        // A remote y-sync transaction is the moment the y-prosemirror binding
        // populates or updates its mapping. Re-resolve from RelativePositions
        // on those. This also handles the initial-mount race where the model
        // can arrive before the binding has any mapping entries at all.
        const ySyncChangeOrigin = isRemoteDocumentRebuild(tr);

        let model = previous.model;
        let activeOperationId = previous.activeOperationId;
        let mustRebuild = false;

        if (meta?.kind === "set-model") {
          model = meta.model;
          mustRebuild = true;
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

        return {
          model,
          activeOperationId,
          decorations,
        };
      },
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
