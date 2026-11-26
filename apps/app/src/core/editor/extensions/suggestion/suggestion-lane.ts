import { type Editor, Extension, type Range } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";

import {
  createDefaultSuggestionDriver,
  type SuggestionChoiceAction,
  type SuggestionDriver,
  type SuggestionDriverFrame,
  type SuggestionHost,
  type SuggestionHostLease,
  type SuggestionKeyBindings,
  type SuggestionMenu,
  type SuggestionMenuModel,
} from "@/core/completion";

export type SuggestionLaneOptions<TCatalog> = {
  catalog: () => TCatalog | null;
  suggestionHost: (editor: Editor) => SuggestionHost | null;
};

export type SuggestionLaneDriverRuntime<TCatalog, TCandidate, TRow, TMeta> = {
  editor: Editor;
  catalog: () => TCatalog | null;
  defaultProject: (
    frame: SuggestionDriverFrame<TCandidate>,
  ) => SuggestionMenuModel<TRow, TMeta> | null;
};
export type SuggestionLaneDriverFactory<TCatalog, TCandidate, TRow, TMeta> = (
  runtime: SuggestionLaneDriverRuntime<TCatalog, TCandidate, TRow, TMeta>,
) => SuggestionDriver<TCandidate, TRow, TMeta>;
export const defaultSuggestionLaneDriver = <TCatalog, TCandidate, TRow, TMeta>(
  runtime: SuggestionLaneDriverRuntime<TCatalog, TCandidate, TRow, TMeta>,
) => createDefaultSuggestionDriver({ project: runtime.defaultProject });

export type SuggestionLaneSpec<TCatalog, TCandidate, TRow = TCandidate, TMeta = null> = {
  name: string;
  char: string;
  allowSpaces?: boolean;
  keymapId: string;
  label: (catalog: TCatalog) => string;
  allows: (doc: PMNode, from: number) => boolean;
  items: (catalog: TCatalog, query: string) => readonly TCandidate[];
  rowId: (entry: TRow) => string;
  entries?: (input: {
    editor: Editor;
    catalog: TCatalog;
    range: Range;
    items: readonly TCandidate[];
  }) => readonly TRow[];
  choosable?: (entry: TRow) => boolean;
  meta?: (catalog: TCatalog) => TMeta;
  choose: (input: {
    editor: Editor;
    catalog: TCatalog;
    range: Range;
    entry: TRow;
    action: SuggestionChoiceAction;
  }) => void;
  driver: SuggestionLaneDriverFactory<TCatalog, TCandidate, TRow, TMeta>;
  keyBindings?: (menu: SuggestionMenu<TRow, TMeta>) => SuggestionKeyBindings;
  backtrack?: (input: { editor: Editor; catalog: TCatalog; range: Range }) => boolean;
};

export type SuggestionLane<TCatalog, TEntry, TMeta = null> = {
  extension: Extension<SuggestionLaneOptions<TCatalog>>;
  getMenu: (editor: Editor | null | undefined) => SuggestionMenu<TEntry, TMeta> | null;
};

export function createSuggestionLane<TCatalog, TCandidate, TRow = TCandidate, TMeta = null>(
  spec: SuggestionLaneSpec<TCatalog, TCandidate, TRow, TMeta>,
): SuggestionLane<TCatalog, TRow, TMeta> {
  const pluginKey = new PluginKey(spec.name);
  const catalogFencePluginKey = new PluginKey(`${spec.name}CatalogFence`);

  type LaneStorage = { driver: SuggestionDriver<TCandidate, TRow, TMeta> | null };

  const extension = Extension.create<SuggestionLaneOptions<TCatalog>, LaneStorage>({
    name: spec.name,
    addOptions() {
      return { catalog: () => null, suggestionHost: () => null };
    },
    addStorage(): LaneStorage {
      return { driver: null };
    },
    addProseMirrorPlugins() {
      const editor = this.editor;
      const options = this.options;
      const catalog = options.catalog;
      const defaultProject = (
        frame: SuggestionDriverFrame<TCandidate>,
      ): SuggestionMenuModel<TRow, TMeta> | null => {
        const current = catalog();
        if (!current) return null;
        const entries = spec.entries
          ? spec.entries({
              editor,
              catalog: current,
              range: frame.triggerRange,
              items: frame.candidates,
            })
          : (frame.candidates as unknown as readonly TRow[]);
        return {
          rows: entries,
          rowId: spec.rowId,
          label: spec.label(current),
          meta: (spec.meta?.(current) ?? null) as TMeta,
          choosable: spec.choosable,
          choose: (entry, action) => {
            const live = catalog();
            if (live)
              spec.choose({ editor, catalog: live, range: frame.triggerRange, entry, action });
          },
          backtrack: spec.backtrack
            ? () => {
                const live = catalog();
                return live
                  ? (spec.backtrack?.({ editor, catalog: live, range: frame.triggerRange }) ??
                      false)
                  : false;
              }
            : undefined,
        };
      };
      const driver = spec.driver({ editor, catalog, defaultProject });
      this.storage.driver = driver;
      const frameFrom = (
        props: SuggestionProps<TCandidate, TRow>,
      ): SuggestionDriverFrame<TCandidate> => ({
        query: props.query,
        text: props.text,
        triggerRange: props.range,
        candidates: props.items,
        anchorRect: props.clientRect ?? (() => null),
        loading: props.loading,
        requestExit: () => exitSuggestion(editor.view, pluginKey),
      });
      return [
        Suggestion<TCandidate, TRow>({
          editor,
          pluginKey,
          char: spec.char,
          allowSpaces: spec.allowSpaces ?? false,
          startOfLine: false,
          allowedPrefixes: null,
          allow: ({ state, range }) =>
            options.catalog() !== null && spec.allows(state.doc, range.from),
          items: ({ query }) => {
            const current = options.catalog();
            return current ? [...spec.items(current, query)] : [];
          },
          command: () => {},
          render: () => {
            let hostLease: SuggestionHostLease | null = null;
            return {
              onStart(props) {
                hostLease?.release();
                hostLease =
                  options.suggestionHost(editor)?.register({
                    id: spec.keymapId,
                    bindings: spec.keyBindings?.(driver.menu) ?? {
                      ArrowDown: () => driver.menu.move(1),
                      ArrowUp: () => driver.menu.move(-1),
                      Enter: () => driver.menu.chooseActive("enter"),
                    },
                    retreat: {
                      backtrack: () => driver.menu.backtrack(),
                      dismiss: () => driver.menu.dismiss(),
                    },
                  }) ?? null;
                driver.start(frameFrom(props));
              },
              onUpdate: (props) => driver.update(frameFrom(props)),
              onExit() {
                hostLease?.release();
                hostLease = null;
                driver.exit();
              },
            };
          },
        }),
        new Plugin({
          key: catalogFencePluginKey,
          view: (view) => ({
            update() {
              if (pluginKey.getState(view.state)?.active && options.catalog() === null)
                exitSuggestion(view, pluginKey);
            },
          }),
        }),
      ];
    },
  });

  const getMenu = (editor: Editor | null | undefined): SuggestionMenu<TRow, TMeta> | null => {
    if (!editor || editor.isDestroyed) return null;
    const storage = editor.storage as unknown as Record<string, LaneStorage | undefined>;
    return storage[spec.name]?.driver?.menu ?? null;
  };

  return { extension, getMenu };
}
