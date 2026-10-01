import type { Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type {
  ReferenceBrowserOpenContext,
  ReferenceCatalogPort,
  ReferenceRow,
  SuggestionMenu,
} from "@/core/completion";
import { createReferenceBrowserController } from "@/core/completion";
import { insertDocumentLink } from "../link-picker";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import { allowsAtTrigger } from "./at-trigger";

export type AtReferenceCatalog = {
  port: ReferenceCatalogPort;
  /** Host-owned terminal transaction; trigger/browser/menu ownership stays shared. */
  insertReference?: (
    editor: import("@tiptap/core").Editor,
    range: Range,
    row: Extract<ReferenceRow, { kind: "file" }>,
  ) => boolean;
  openContext: () => ReferenceBrowserOpenContext | null;
  label: string;
  /** The URI of the document a reference goes into; what its link is spelled relative to. */
  holderUri?: string | null;
};
export type AtReferenceMenu = SuggestionMenu<
  ReferenceRow,
  import("@/core/completion").ReferenceBrowserMeta
>;

function insertReference(
  editor: import("@tiptap/core").Editor,
  range: Range,
  row: Extract<ReferenceRow, { kind: "file" }>,
  holderUri: string | null,
) {
  const reference = row.action.reference;
  if (row.fileKind === "asset") {
    return editor
      .chain()
      .focus()
      .insertContentAt(range, {
        type: "image",
        attrs: { src: `asset:${reference.documentId}`, alt: reference.label, title: null },
      })
      .run();
  }
  return insertDocumentLink(editor, range, {
    label: reference.label,
    uri: reference.uri,
    holderUri,
  });
}

const lane = createSuggestionLane<
  AtReferenceCatalog,
  never,
  ReferenceRow,
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
      onCompleteSegment: ({ prefix, triggerRange }) => {
        editor.chain().focus().insertContentAt(triggerRange, prefix).run();
      },
      onSelect: ({ row, triggerRange }) => {
        yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
        editor.view.dispatch(closeHistory(editor.state.tr));
        const current = catalog();
        if (current?.insertReference) current.insertReference(editor, triggerRange, row);
        else insertReference(editor, triggerRange, row, current?.holderUri ?? null);
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
