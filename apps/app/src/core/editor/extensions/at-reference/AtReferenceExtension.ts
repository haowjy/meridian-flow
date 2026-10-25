import type { Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type {
  ReferenceBrowserOpenContext,
  ReferenceCatalogPort,
  ReferenceMenuRow,
  ReferenceTerminalRow,
  SuggestionMenu,
} from "@/core/completion";
import { createReferenceBrowserController } from "@/core/completion";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import { allowsAtTrigger } from "./at-trigger";
import {
  documentReferenceNode,
  folderReferenceNode,
  insertLinkAhead,
} from "./document-link-insertion";

export type ReferenceBrowserCatalog = {
  port: ReferenceCatalogPort;
  /** Cheap identity lookup over the catalog snapshots already installed for this surface. */
  resolveReference: (reference: {
    kind: "file" | "folder";
    id: string;
  }) => ReferenceTerminalRow | null;
  openContext: () => ReferenceBrowserOpenContext | null;
  label: string;
  /**
   * The Editor's link-ahead row: where a link to a not-yet-written document
   * named `name` would point, or null for none. Omitted where a reference
   * must name an existing document (the chat composer).
   */
  linkAhead?: (name: string) => { uri: string } | null;
};

export type AtReferenceCatalog = ReferenceBrowserCatalog & {
  /** The host's canonical node for a terminal row, shared by `@` and row drops. */
  referenceNode: (schema: Schema, row: ReferenceTerminalRow) => PMNode | null;
};

/** The exact Editor node shape written by `@`, also used by row drops. */
export function editorReferenceNode(schema: Schema, row: ReferenceTerminalRow): PMNode | null {
  if (row.kind === "folder-mention") return folderReferenceNode(schema, row.action.reference);
  const reference = row.action.reference;
  if (row.fileKind === "asset")
    return (
      schema.nodes.image?.create({
        src: `asset:${reference.documentId}`,
        alt: reference.label,
        title: null,
      }) ?? null
    );
  return documentReferenceNode(schema, reference);
}
export type AtReferenceMenu = SuggestionMenu<
  ReferenceMenuRow,
  import("@/core/completion").ReferenceBrowserMeta
>;

function insertReference(editor: import("@tiptap/core").Editor, range: Range, node: PMNode) {
  return editor.chain().focus().insertContentAt(range, node).unsetMark("link").run();
}

const lane = createSuggestionLane<
  AtReferenceCatalog,
  never,
  ReferenceMenuRow,
  import("@/core/completion").ReferenceBrowserMeta
>({
  name: "atReferenceSuggestion",
  char: "@",
  allowSpaces: true,
  keymapId: "at-reference-menu",
  label: (catalog) => catalog.label,
  allows: allowsAtTrigger,
  items: () => [],
  rowId: (row) => row.rowId,
  choose: () => {},
  driver: ({ editor, catalog }) =>
    createReferenceBrowserController({
      catalog: {
        subscribe: (listener) => catalog()?.port.subscribe(listener) ?? (() => {}),
        status: (scope) => catalog()?.port.status(scope) ?? "loading",
        read: (scope) => catalog()?.port.read(scope) ?? null,
        acquire: (scope, signal) => {
          const current = catalog();
          if (!current) return Promise.reject(new Error("Reference catalog unavailable"));
          return current.port.acquire(scope, signal);
        },
      },
      openContext: () => catalog()?.openContext() ?? null,
      label: () => catalog()?.label ?? "References",
      linkAhead: (name) => catalog()?.linkAhead?.(name) ?? null,
      onLinkAhead: ({ row, triggerRange }) => {
        yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
        editor.view.dispatch(closeHistory(editor.state.tr));
        insertLinkAhead(editor, triggerRange, { label: row.label, uri: row.uri });
      },
      onCompleteSegment: ({ prefix, triggerRange }) => {
        editor.chain().focus().insertContentAt(triggerRange, prefix).run();
      },
      onSelect: ({ row, triggerRange }) => {
        yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
        editor.view.dispatch(closeHistory(editor.state.tr));
        const current = catalog();
        const node = current?.referenceNode(editor.schema, row);
        if (node) insertReference(editor, triggerRange, node);
      },
    }),
  keyBindings: (menu) => ({
    ArrowDown: () => menu.move(1),
    ArrowUp: () => menu.move(-1),
    Home: () => menu.moveTo("first"),
    End: () => menu.moveTo("last"),
    Enter: () => menu.chooseActive("enter"),
    Tab: () => menu.chooseActive("tab"),
  }),
});
export const AtReferenceExtension = lane.extension;
export const getAtReferenceMenu = lane.getMenu;
export type AtReferenceExtensionOptions = Pick<
  SuggestionLaneOptions<AtReferenceCatalog>,
  "catalog"
>;
