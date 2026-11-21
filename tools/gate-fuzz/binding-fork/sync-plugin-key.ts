import type { ContainerID, Cursor, LoroDoc, Subscription } from "loro-crdt";
import type { Node } from "prosemirror-model";
import { PluginKey, type Selection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { LoroDocType, LoroNodeMapping } from "./lib";

export const loroSyncPluginKey = new PluginKey<LoroSyncPluginState>("loro-sync");

/** The meta key a transaction's Loro commit origin rides under (`setCommitOrigin`). */
export const loroCommitOriginKey = new PluginKey<string>("loro-commit-origin");

/**
 * Commit this transaction's Loro write under `origin`, so an UndoManager can include or exclude
 * it by origin prefix. A transaction without one commits as `loroSyncPlugin`.
 */
export function setCommitOrigin(tr: Transaction, origin: string): Transaction {
  return tr.setMeta(loroCommitOriginKey, origin);
}

export interface LoroSyncPluginProps {
  doc: LoroDocType;
  mapping?: LoroNodeMapping;
  containerId?: ContainerID;
}

export interface LoroSyncPluginState extends LoroSyncPluginProps {
  changedBy: "local" | "import" | "checkout";
  mapping: LoroNodeMapping;
  snapshot?: LoroDoc | null;
  view?: EditorView;
  containerId?: ContainerID;
  docSubscription?: Subscription | null;
  /** Whether `init` has read the Loro document into the editor; no write goes to Loro before. */
  initialized: boolean;
  /** The selection as Loro cursors, taken for this doc and selection (`rememberSelection`). */
  selectionCursors?: {
    doc: Node;
    selection: Selection;
    anchor?: Cursor;
    focus?: Cursor;
    /** The cursors hold the character before a collapsed caret; the caret is one past them. */
    afterChar: boolean;
  };
}
