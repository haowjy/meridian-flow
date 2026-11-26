import type { Range } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import type {
  ReferenceBrowserOpenContext,
  ReferenceCatalogPort,
  ReferenceMenuRow,
  ReferenceTerminalRow,
  SuggestionMenu,
} from "@/core/completion";
import { createReferenceBrowserController } from "@/core/completion";
import { endUndoStep } from "../../editor-history";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import { allowsAtTrigger } from "./at-trigger";
import {
  documentReferenceNode,
  folderReferenceNode,
  insertLinkAhead,
} from "./document-link-insertion";

export type ReferenceBrowserCatalog = {
  port: ReferenceCatalogPort;
  resolveReference: (reference: {
    kind: "file" | "folder";
    id: string;
  }) => ReferenceTerminalRow | null;
  openContext: () => ReferenceBrowserOpenContext | null;
  label: string;
  linkAhead?: (name: string) => { uri: string } | null;
};

export type AtReferenceCatalog = ReferenceBrowserCatalog & {
  referenceNode: (schema: Schema, row: ReferenceTerminalRow) => PMNode | null;
};

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
      },
      openContext: () => catalog()?.openContext() ?? null,
      label: () => catalog()?.label ?? "References",
      linkAhead: (name) => catalog()?.linkAhead?.(name) ?? null,
      onLinkAhead: ({ row, triggerRange }) => {
        endUndoStep(editor.state);
        insertLinkAhead(editor, triggerRange, { label: row.label, uri: row.uri });
      },
      onCompleteSegment: ({ prefix, triggerRange }) => {
        editor.chain().focus().insertContentAt(triggerRange, prefix).run();
      },
      onSelect: ({ row, triggerRange }) => {
        endUndoStep(editor.state);
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
