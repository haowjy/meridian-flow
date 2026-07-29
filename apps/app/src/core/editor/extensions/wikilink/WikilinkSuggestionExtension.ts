/**
 * The `[[` trigger: two brackets in prose open the document menu (§5.5).
 *
 * The same wiring the slash trigger uses, over the same store, because a
 * writer meets both the same way — the query is the prose, the caret stays in
 * it, and Escape leaves the literal `[[` text alone. What differs is only what
 * this offers and what a choice writes: `wikilink-trigger.ts` says where it
 * may open, `wikilink-catalog.ts` says what matched, and
 * `wikilink-insertion.ts` says what lands in the document.
 *
 * `allowSpaces` is on, and has to be: document titles have spaces in them, and
 * a menu that stopped filtering at "The Second" would be a menu that cannot
 * find "The Second Gate". The cost is that the match runs to the end of the
 * text node, which is why the catalog refuses a query carrying `]` — a writer
 * who closed the brackets themselves is left alone with their own text.
 */

import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";

import { getEditorChrome } from "../../chrome";
import {
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuController,
  type SuggestionMenuSession,
  type SuggestionMenuSnapshot,
} from "../suggestion";
import {
  filterWikilinkItems,
  type WikilinkExtensionOptions,
  type WikilinkMenuItem,
} from "./wikilink-catalog";
import { insertWikilink } from "./wikilink-insertion";
import { allowsWikilinkTrigger } from "./wikilink-trigger";

const WIKILINK_EXTENSION_NAME = "wikilinkSuggestion";

export const wikilinkSuggestionPluginKey = new PluginKey(WIKILINK_EXTENSION_NAME);

const wikilinkCatalogFencePluginKey = new PluginKey(`${WIKILINK_EXTENSION_NAME}CatalogFence`);

export type WikilinkMenu = SuggestionMenu<WikilinkMenuItem>;
export type WikilinkMenuSnapshot = SuggestionMenuSnapshot<WikilinkMenuItem>;

type WikilinkStorage = {
  menu: WikilinkMenu;
  /** @internal driven by this extension only. */
  controller: SuggestionMenuController<WikilinkMenuItem>;
};

declare module "@tiptap/core" {
  interface Storage {
    wikilinkSuggestion: WikilinkStorage;
  }
}

/**
 * The open `[[` menu for this editor, or null on a surface that never mounted
 * the extension (a code file, a read-only viewer). Null is a real state.
 */
export function getWikilinkMenu(editor: Editor | null | undefined): WikilinkMenu | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[WIKILINK_EXTENSION_NAME]?.menu ?? null;
}

export const WikilinkSuggestionExtension = Extension.create<WikilinkExtensionOptions>({
  name: WIKILINK_EXTENSION_NAME,

  addOptions() {
    return { catalog: () => null };
  },

  addStorage(): WikilinkStorage {
    return createSuggestionMenu<WikilinkMenuItem>();
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    const { menu, controller } = this.storage;

    const sessionFrom = (
      props: SuggestionProps<WikilinkMenuItem, WikilinkMenuItem>,
    ): SuggestionMenuSession<WikilinkMenuItem> | null => {
      const catalog = options.catalog();
      if (!catalog) return null;
      return {
        items: props.items,
        query: props.query,
        anchorRect: props.clientRect ?? (() => null),
        label: catalog.label,
        meta: null,
        choose: (item) => props.command(item),
        dismiss: () => exitSuggestion(editor.view, wikilinkSuggestionPluginKey),
      };
    };

    return [
      Suggestion<WikilinkMenuItem, WikilinkMenuItem>({
        editor,
        pluginKey: wikilinkSuggestionPluginKey,
        char: "[[",
        startOfLine: false,
        allowedPrefixes: null,
        allowSpaces: true,
        allow: ({ state, range }) =>
          options.catalog() !== null && allowsWikilinkTrigger(state.doc, range.from),
        items: ({ query }) => filterWikilinkItems(options.catalog()?.documents ?? [], query),
        command: ({ editor: target, range, props }) => {
          // Withdrawn between the row being drawn and the row being chosen:
          // take the menu down rather than write from a dead list.
          if (!options.catalog()) {
            exitSuggestion(target.view, wikilinkSuggestionPluginKey);
            return;
          }
          insertWikilink(target, range, props.name);
        },
        render: () => {
          let releaseKeymap: (() => void) | null = null;

          return {
            onStart(props) {
              const session = sessionFrom(props);
              if (!session) return;
              controller.open(session);

              // Registered here rather than from the surface's effect: the menu
              // is on screen the instant the second bracket lands, and a writer
              // who types `[[` and ArrowDown in one motion must not out-run
              // React.
              releaseKeymap =
                getEditorChrome(editor)?.registerKeymap({
                  id: "wikilink-menu",
                  scope: "layer",
                  bindings: {
                    ArrowDown: () => menu.move(1),
                    ArrowUp: () => menu.move(-1),
                    Enter: () => menu.chooseActive(),
                  },
                }) ?? null;
            },

            onUpdate(props) {
              const session = sessionFrom(props);
              if (session) controller.update(session);
            },

            onExit() {
              releaseKeymap?.();
              releaseKeymap = null;
              controller.close();
            },
          };
        },
      }),

      // Editability flips without a transaction (`setEditable` re-runs plugin
      // VIEWS, not plugin `apply`), so a menu already open when a schema fence
      // lands would keep offering rows that can no longer be written. Exiting
      // here means withdrawal leaves by the same door as Escape, and the
      // keymap and the chrome layer are released once.
      new Plugin({
        key: wikilinkCatalogFencePluginKey,
        view: (view) => ({
          update() {
            if (!wikilinkSuggestionPluginKey.getState(view.state)?.active) return;
            if (options.catalog() === null) exitSuggestion(view, wikilinkSuggestionPluginKey);
          },
        }),
      }),
    ];
  },
});
