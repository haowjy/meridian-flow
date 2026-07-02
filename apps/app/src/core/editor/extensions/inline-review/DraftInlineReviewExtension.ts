/**
 * DraftInlineReviewExtension — the writer's Track-Changes surface on the
 * draft editor.
 *
 * Owns a single `DecorationSet` describing every hunk in the current server
 * review model: `Decoration.inline` for insertions, `Decoration.widget` for
 * deletions. The plugin is the single owner of decoration state; React only
 * talks to it through TipTap commands and read-only plugin state.
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
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

import { buildDecorations, resolverFromState } from "./decorations";
import type { InlineReviewModel } from "./model";

export interface DraftInlineReviewOptions {
  /** Optional initial model — usually the plugin starts empty and receives the model via command. */
  initialModel: InlineReviewModel | null;
  /**
   * Called with the first draft-doc position of the active operation whenever
   * `setInlineReviewActiveOperation` picks a new operation. Hosts (the
   * sidebar) can use this to synchronise their own scroll/announce logic.
   */
  onFocusOperation?: (payload: { operationId: string; firstPos: number | null }) => void;
}

/** A decoration DOM node carries operation attribution on `data-review-operations`. */
const OPERATION_ATTR = "data-review-operations";

export interface InlineReviewPluginState {
  model: InlineReviewModel | null;
  activeOperationId: string | null;
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
      onFocusOperation: undefined,
    };
  },

  addProseMirrorPlugins() {
    const { initialModel, onFocusOperation } = this.options;
    return [buildInlineReviewPlugin({ initialModel, onFocusOperation })];
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
        ({ tr, dispatch, state }) => {
          const firstPos = firstPositionForOperation(state, operationId);
          if (firstPos == null) return false;
          if (!dispatch) return true;
          tr.setSelection(TextSelection.near(tr.doc.resolve(firstPos)));
          tr.scrollIntoView();
          tr.setMeta("addToHistory", false);
          dispatch(tr);
          return true;
        },
    };
  },
});

interface PluginContext {
  initialModel: InlineReviewModel | null;
  onFocusOperation?: DraftInlineReviewOptions["onFocusOperation"];
}

function buildInlineReviewPlugin({ initialModel, onFocusOperation }: PluginContext) {
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

        return { model, activeOperationId, decorations };
      },
    },
    props: {
      decorations(state) {
        return draftInlineReviewPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
      // Editor-side click seam. A click on any hunk decoration DOM adopts its
      // first-listed operation as the active one — the sidebar reads plugin
      // state and reacts (scroll card into view + emphasize). The plugin's
      // `view` hook fires `onFocusOperation` on the resulting state change.
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
    view() {
      // Emit focus notifications only when the active operation actually
      // changes, so hosts observe transitions rather than every keystroke.
      let lastActiveOperationId: string | null = null;
      return {
        update(view) {
          const pluginState = draftInlineReviewPluginKey.getState(view.state);
          if (!pluginState) return;
          if (pluginState.activeOperationId === lastActiveOperationId) return;
          lastActiveOperationId = pluginState.activeOperationId;
          if (!onFocusOperation || !pluginState.activeOperationId) return;
          const firstPos = firstPositionForOperation(view.state, pluginState.activeOperationId);
          onFocusOperation({
            operationId: pluginState.activeOperationId,
            firstPos,
          });
        },
      };
    },
  });
}

/** Utility to read the current plugin state from any EditorState. */
export function getInlineReviewPluginState(state: EditorState): InlineReviewPluginState | null {
  return draftInlineReviewPluginKey.getState(state) ?? null;
}

/**
 * Locate the earliest draft-doc position tied to `operationId`. Used by both
 * the scroll command and the focus-operation notification. Returns `null`
 * when the operation is unknown or none of its hunks resolve right now.
 */
export function firstPositionForOperation(state: EditorState, operationId: string): number | null {
  const pluginState = draftInlineReviewPluginKey.getState(state);
  if (!pluginState?.model) return null;
  const hunk = pluginState.model.hunks.find((candidate) =>
    candidate.operationIds.includes(operationId),
  );
  if (!hunk) return null;
  const resolver = resolverFromState(state);
  if (!resolver) return null;
  const [decoration] = pluginState.decorations.find(
    0,
    resolver.doc.content.size,
    (spec) => (spec as { [key: string]: unknown })["data-review-hunk"] === hunk.hunkId,
  );
  return decoration?.from ?? null;
}
