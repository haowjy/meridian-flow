/**
 * The slash trigger: `/` in prose opens the insertion menu.
 *
 * Three modules meet here and none of them is this file's business.
 * `slash-trigger.ts` decides where `/` may open, `slash-insertion.ts` decides
 * what a choice does to the document, and `slash-menu-store.ts` holds the open
 * menu for React. What is left is wiring `@tiptap/suggestion` to them.
 *
 * Two things this deliberately does NOT do:
 *
 * - **Own Escape.** The chrome kernel does (`escStep`), and it runs first at
 *   priority 1050; the menu takes its step by being a registered layer, which
 *   the React surface does when it opens. Suggestion's own Escape handling
 *   stays as the floor under that, for the frame before React has rendered.
 * - **Gate on transaction origin.** `shouldShow` is evaluated on every
 *   transaction, so using it to keep remote writes from opening the menu would
 *   also close an open menu every time a collaborator typed anywhere in the
 *   chapter. The trigger already needs the local caret to sit on the `/`.
 */

import { type Editor, Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";

import { getEditorChrome } from "../../chrome";
import {
  filterSlashCommandItems,
  type SlashCommandExtensionOptions,
  type SlashCommandItem,
} from "./slash-catalog";
import { applySlashCommand } from "./slash-insertion";
import {
  createSlashMenu,
  type SlashMenu,
  type SlashMenuController,
  type SlashMenuSession,
} from "./slash-menu-store";
import { allowsSlashTrigger } from "./slash-trigger";

const SLASH_EXTENSION_NAME = "slashCommand";

export const slashCommandPluginKey = new PluginKey(SLASH_EXTENSION_NAME);

type SlashCommandStorage = {
  menu: SlashMenu;
  /** @internal driven by this extension only. */
  controller: SlashMenuController;
};

declare module "@tiptap/core" {
  interface Storage {
    slashCommand: SlashCommandStorage;
  }
}

/**
 * The open menu for this editor, or null on a surface that never mounted the
 * extension (a code file, a read-only viewer). Null is a real state.
 */
export function getSlashMenu(editor: Editor | null | undefined): SlashMenu | null {
  if (!editor || editor.isDestroyed) return null;
  return editor.storage[SLASH_EXTENSION_NAME]?.menu ?? null;
}

export const SlashCommandExtension = Extension.create<SlashCommandExtensionOptions>({
  name: SLASH_EXTENSION_NAME,

  addOptions() {
    return { catalog: () => null };
  },

  addStorage(): SlashCommandStorage {
    return createSlashMenu();
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    const { menu, controller } = this.storage;

    const sessionFrom = (
      props: SuggestionProps<SlashCommandItem, SlashCommandItem>,
    ): SlashMenuSession | null => {
      const catalog = options.catalog();
      if (!catalog) return null;
      return {
        items: props.items,
        query: props.query,
        anchorRect: props.clientRect ?? (() => null),
        label: catalog.menuLabel,
        groupLabels: catalog.groupLabels,
        choose: (item) => props.command(item),
        dismiss: () => exitSuggestion(editor.view, slashCommandPluginKey),
      };
    };

    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor,
        pluginKey: slashCommandPluginKey,
        char: "/",
        // The envelope is the predicate's, not the plugin's: `startOfLine` and
        // `allowedPrefixes` would express two thirds of §5.7 in configuration
        // and leave the rest in code, which is how the old trigger ended up
        // with rules nobody could read.
        startOfLine: false,
        allowedPrefixes: null,
        allow: ({ state, range }) =>
          options.catalog() !== null && allowsSlashTrigger(state.doc, range.from),
        items: ({ query }) => filterSlashCommandItems(options.catalog()?.items ?? [], query),
        command: ({ editor: target, range, props }) => {
          const catalog = options.catalog();
          if (catalog) applySlashCommand(target, range, props, catalog);
        },
        render: () => {
          let releaseKeymap: (() => void) | null = null;

          return {
            onStart(props) {
              const session = sessionFrom(props);
              if (!session) return;
              controller.open(session);

              // Registered here rather than from the surface's effect: the
              // menu is on screen the instant the `/` lands, and a writer who
              // types `/` and ArrowDown in one motion must not out-run React.
              releaseKeymap =
                getEditorChrome(editor)?.registerKeymap({
                  id: "slash-menu",
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
    ];
  },
});
