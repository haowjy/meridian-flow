import type { Cursor, LoroEventBatch, LoroMap } from "loro-crdt";
import { Fragment, Slice } from "prosemirror-model";
import { type EditorState, Plugin, type StateField, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { attachCompositionHold } from "./composition-hold";
import { convertPmSelectionToCursors, cursorToAbsolutePosition } from "./cursor/common";
import {
  clearChangedNodes,
  createNodeFromLoroObj,
  type LocalChange,
  type LoroDocType,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  ROOT_DOC_KEY,
  safeSetSelection,
  updateLoroToPmState,
} from "./lib";
import {
  type LoroSyncPluginProps,
  type LoroSyncPluginState,
  loroCommitOriginKey,
  loroSyncPluginKey,
} from "./sync-plugin-key";
import { configLoroTextStyle } from "./text-style";
import { loroUndoPluginKey } from "./undo-plugin-key";

type PluginTransactionType =
  | {
      type: "doc-changed";
      change: LocalChange;
    }
  | {
      type: "non-local-updates";
    }
  | {
      type: "update-state";
      state: Partial<LoroSyncPluginState>;
    };

export const LoroSyncPlugin = (props: LoroSyncPluginProps): Plugin => {
  return new Plugin({
    key: loroSyncPluginKey,
    props: {
      editable: (state) => {
        const syncState = loroSyncPluginKey.getState(state);
        return syncState?.snapshot == null;
      },
    },
    state: {
      init: (_config, editorState): LoroSyncPluginState => {
        configLoroTextStyle(props.doc, editorState.schema);

        return {
          doc: props.doc,
          mapping: props.mapping ?? new Map(),
          changedBy: "local",
          containerId: props.containerId,
          initialized: false,
        };
      },
      apply: (tr, state, oldEditorState, newEditorState) => {
        const meta = tr.getMeta(loroSyncPluginKey) as PluginTransactionType | null;
        const undoState = loroUndoPluginKey.getState(oldEditorState);

        if (meta?.type === "non-local-updates") {
          state.changedBy = "import";
        } else {
          state.changedBy = "local";
        }
        switch (meta?.type) {
          case "doc-changed":
            // Before `init` the mapping is empty, and a write against it would replace the
            // Loro content with the editor's placeholder document (upstream #77).
            if (state.initialized && !undoState?.isUndoing.current) {
              updateLoroToPmState(
                state.doc as LoroDocType,
                state.mapping,
                newEditorState,
                props.containerId,
                meta.change,
              );
            }
            break;
          case "update-state":
            state = { ...state, ...meta.state, initialized: true };
            state.doc.commit({
              origin: "sys:init",
              timestamp: Math.floor(Date.now() / 1000),
            });
            break;
          default:
            break;
        }
        return state;
      },
    } as StateField<LoroSyncPluginState>,
    appendTransaction: (transactions, oldEditorState, newEditorState) => {
      // The plugin's own transactions carry Loro's state into the editor; writing them back
      // would re-derive Loro's structure from the editor at a moment it isn't authoritative
      // (upstream #77).
      const local = transactions.filter((tr) => tr.docChanged && !tr.getMeta(loroSyncPluginKey));
      if (local.length === 0) return null;
      const origin = transactions
        .map((tr) => tr.getMeta(loroCommitOriginKey) as string | undefined)
        .find((o) => o != null);
      const change: LocalChange = { transactions, oldEditorState, origin };
      return newEditorState.tr.setMeta(loroSyncPluginKey, {
        type: "doc-changed",
        change,
      });
    },
    view: (view: EditorView) => {
      const timeoutId = setTimeout(() => init(view), 0);
      const hold = attachCompositionHold(props.doc, view);
      return {
        update: (view: EditorView, prevState: EditorState) => {
          rememberSelection(view, prevState);
          hold.update();
        },
        destroy: () => {
          clearTimeout(timeoutId);
          hold.destroy();
        },
      };
    },
  });
};

// This is called when the plugin's state is associated with an editor view
function init(view: EditorView) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;

  let docSubscription = state.docSubscription;

  docSubscription?.();

  if (state.containerId) {
    docSubscription = state.doc!.getContainerById(state.containerId)!.subscribe((event) => {
      updateNodeOnLoroEvent(view, event);
    });
  } else {
    docSubscription = state.doc.subscribe((event) => updateNodeOnLoroEvent(view, event));
  }

  const innerDoc = state.containerId
    ? (state.doc.getContainerById(state.containerId) as LoroMap<LoroNodeContainerType>)
    : (state.doc as LoroDocType).getMap(ROOT_DOC_KEY);

  const mapping: LoroNodeMapping = new Map();
  const placeholder = view.state.doc.type.createAndFill();
  if (
    innerDoc.size === 0 &&
    placeholder != null &&
    view.state.doc.content.findDiffStart(placeholder.content) !== null
  ) {
    // An empty Loro document under an editor that already holds content (the initial state, or
    // a dispatch before this ran): the editor's content seeds the document instead of being
    // deleted (the follow-up upstream #77 asks for).
    updateLoroToPmState(state.doc as LoroDocType, mapping, view.state, state.containerId);
    const tr = view.state.tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
    });
    view.dispatch(tr);
  } else if (innerDoc.size === 0) {
    // Empty doc
    const tr = view.state.tr.delete(0, view.state.doc.content.size);
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
    });
    view.dispatch(tr);
  } else {
    const schema = view.state.schema;
    // Create node from loro object
    const node = createNodeFromLoroObj(schema, innerDoc as LoroMap<LoroNodeContainerType>, mapping);
    const tr = view.state.tr.replace(
      0,
      view.state.doc.content.size,
      new Slice(Fragment.from(node), 0, 0),
    );
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
    });
    view.dispatch(tr);
  }
}

function updateNodeOnLoroEvent(view: EditorView, event: LoroEventBatch) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;
  state.changedBy = event.by;
  if (event.by === "local" && event.origin !== "undo") {
    return;
  }

  const mapping = state.mapping;
  clearChangedNodes(state.doc as LoroDocType, event, mapping);
  const node = createNodeFromLoroObj(
    view.state.schema,
    state.containerId
      ? (state.doc.getContainerById(state.containerId) as LoroMap<LoroNodeContainerType>)
      : (state.doc as LoroDocType).getMap(ROOT_DOC_KEY),
    mapping,
  );
  // The cursors are the ones taken when the editor and Loro last agreed: the selection's
  // offsets read against the text after the import would move the caret by whatever a peer
  // typed before it in the same block.
  const remembered =
    state.selectionCursors?.doc === view.state.doc &&
    state.selectionCursors.selection === view.state.selection
      ? state.selectionCursors
      : null;
  const { anchor, focus } =
    remembered ?? convertPmSelectionToCursors(view.state.doc, view.state.selection, state);
  const shift = remembered?.afterChar ? 1 : 0;

  const tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(node), 0, 0),
  );

  tr.setMeta(loroSyncPluginKey, {
    type: "non-local-updates",
  });
  // Restore the selection in the same transaction. Doing it from a timer
  // leaves the caret at the end of the replaced document until the timer
  // fires, and a timer scheduled for an older event can overwrite a newer
  // local selection.
  if (anchor != null) {
    const anchorPos = cursorToAbsolutePosition(anchor, state.doc, mapping)[0] + shift;
    const focusPos = focus
      ? cursorToAbsolutePosition(focus, state.doc, mapping)[0] + shift
      : anchorPos;
    const size = tr.doc.content.size;
    if (
      anchorPos != null &&
      focusPos != null &&
      anchorPos >= 0 &&
      focusPos >= 0 &&
      anchorPos <= size &&
      focusPos <= size
    ) {
      tr.setSelection(TextSelection.between(tr.doc.resolve(anchorPos), tr.doc.resolve(focusPos)));
    }
  }
  view.dispatch(tr);
}

/**
 * Keep the selection as Loro cursors while the editor and Loro agree (after every transaction),
 * so a remote update can put the caret back where it was in the text it was in.
 */
function rememberSelection(view: EditorView, prevState: EditorState) {
  const state = loroSyncPluginKey.getState(view.state);
  if (state == null || !state.initialized) return;
  const remembered = state.selectionCursors;
  if (
    remembered != null &&
    remembered.doc === view.state.doc &&
    remembered.selection === view.state.selection
  )
    return;
  if (
    remembered != null &&
    prevState.doc === view.state.doc &&
    prevState.selection.eq(view.state.selection)
  ) {
    remembered.selection = view.state.selection;
    return;
  }
  // A caret after a character holds on to that character, so a peer's text landing exactly at
  // the caret goes after it: the caret stays with what the writer just typed. (Loro's text
  // cursor holds the character at its offset, whatever its side, so this is the char before.)
  const selection = view.state.selection;
  const afterChar = selection.empty && selection.$head.nodeBefore?.isText === true;
  const { anchor, focus } = convertPmSelectionToCursors(
    view.state.doc,
    afterChar ? TextSelection.create(view.state.doc, selection.head - 1) : selection,
    state,
  );
  state.selectionCursors = {
    doc: view.state.doc,
    selection,
    anchor,
    focus,
    afterChar,
  };
}

/**
 * Update ProseMirror selection based on the given Loro cursors.
 */
export function syncCursorsToPmSelection(view: EditorView, anchor: Cursor, focus?: Cursor) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state);
  if (!state) {
    return;
  }

  const { doc, mapping } = state;
  const anchorPos = cursorToAbsolutePosition(anchor, doc, mapping)[0];
  const focusPos = focus && cursorToAbsolutePosition(focus, doc, mapping)[0];
  if (anchorPos == null) {
    return;
  }

  // If the cursors are synced faster than the document, then the cursors might
  // be out of bounds. Thus, we need to check if the cursors are out of bounds.
  safeSetSelection(view, anchorPos, focusPos);
}
