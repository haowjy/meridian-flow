import type { Range } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type {
  ReferenceBrowserOpenContext,
  ReferenceCatalogPort,
  ReferenceMenuRow,
  ReferenceRow,
  SuggestionMenu,
} from "@/core/completion";
import { createReferenceBrowserController } from "@/core/completion";
import { linkPastedWikilinks } from "../../links/wikilink-paste";
import { createSuggestionLane, type SuggestionLaneOptions } from "../suggestion";
import { allowsAtTrigger } from "./at-trigger";
import { insertDocumentLink } from "./document-link-insertion";

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
  /**
   * The Editor's link-ahead row: where a link to a not-yet-written document
   * named `name` (under `folders` from the area root, for a pasted path link)
   * would point, or null for none. Omitted where a reference must name an
   * existing document (the chat composer).
   */
  linkAhead?: (name: string, folders?: readonly string[]) => { uri: string } | null;
  /**
   * The addresses a pasted `[[Name]]` may name: the documents this menu
   * offers. Null while they are still loading, which leaves a paste's
   * brackets as text. Omitted where paste never converts (the chat composer).
   */
  linkTargets?: () => readonly string[] | null;
};
export type AtReferenceMenu = SuggestionMenu<
  ReferenceMenuRow,
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
        // A link, never a document: the chip is dashed until a follow's
        // Create makes the document at exactly this address.
        insertDocumentLink(editor, triggerRange, {
          label: row.label,
          uri: row.uri,
          holderUri: catalog()?.holderUri ?? null,
        });
      },
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
const wikilinkPastePluginKey = new PluginKey("wikilinkPaste");

/**
 * The `@` lane, plus the one other way a link enters an Editor from its
 * catalog: a paste whose `[[Name]]` becomes a standard link (D15). Every paste
 * kind (Markdown, plain text, HTML) reaches `transformPasted` once, after it
 * is parsed, so the conversion sees nodes and can leave code alone.
 */
export const AtReferenceExtension = lane.extension.extend({
  addProseMirrorPlugins() {
    const catalog = this.options.catalog;
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: wikilinkPastePluginKey,
        props: {
          // ProseMirror's third argument says the slice came from clipboard
          // text, not that the writer pasted without formatting, so it is no
          // reason to decline: text is exactly where an Obsidian note arrives.
          transformPasted: (slice, view) => {
            // A drag inside the editor moves text it already holds, which
            // stays as written.
            if (view.dragging) return slice;
            const current = catalog();
            const targets = current?.linkTargets?.();
            const linkAhead = current?.linkAhead;
            if (!current || !targets || !linkAhead) return slice;
            return linkPastedWikilinks(slice, view.state.schema, {
              holderUri: current.holderUri ?? null,
              targets,
              linkAhead: (name, folders) => linkAhead(name, folders),
            });
          },
        },
      }),
    ];
  },
});
export const getAtReferenceMenu = lane.getMenu;
export type AtReferenceExtensionOptions = Pick<
  SuggestionLaneOptions<AtReferenceCatalog>,
  "catalog"
>;
