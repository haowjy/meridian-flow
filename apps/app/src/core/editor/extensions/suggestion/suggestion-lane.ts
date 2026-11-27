/**
 * One mechanism for every menu the writer types underneath, reading a spec.
 *
 * `/` and `@` are the same machine with different envelopes: a plugin key, a
 * driver in extension storage, one `@tiptap/suggestion` plugin, arrow keys
 * registered against the chrome kernel, and a plugin view that closes the menu
 * when the host's catalog is withdrawn. None of that is where the lanes differ,
 * and all of it is where the failures live — first-keystroke keymap timing,
 * catalog withdrawal, dismissal, plugin lifetime. So it exists once here, and a
 * lane declares only its own answers: what opens it, where it may open, what
 * matched, how the rows read, and what a choice writes.
 *
 * A lane is one call to `createSuggestionLane`. Adding a trigger adds a spec,
 * the same way adding a closer adds a row to
 * [`../auto-pair/auto-pairs.ts`](../auto-pair/auto-pairs.ts) and adding a
 * selectable object adds a row to
 * [`../../objects/object-types.ts`](../../objects/object-types.ts).
 *
 * Two things this deliberately does NOT do, for every lane at once:
 *
 * - **Own Escape.** The host does. The lane registers semantic retreat beside
 *   its ordinary bindings, so editor Chrome and Composer can place the same
 *   backtrack/root-dismiss action in their own arbitration order.
 * - **Gate on transaction origin.** `shouldShow` is evaluated on every
 *   transaction, so using it to keep remote writes from opening a menu would
 *   also close an open menu every time a collaborator typed anywhere in the
 *   chapter. A lane's own predicate already needs the local caret.
 *
 * One thing it inherits rather than decides: a dismissal stays dismissed. The
 * suggestion plugin maps the dismissed range forward, so a second trigger typed
 * against a dismissed one is the same trigger — the menu comes back when the
 * trigger text is deleted, not when it is repeated.
 */

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

/**
 * What the host offers a lane.
 *
 * Read when the menu opens, never at construction: a catalog carries localized
 * labels and host callbacks that must stay live, and making them construction
 * facts would put a locale switch on the editor's remount path. Null leaves the
 * lane mounted and silent, so a read-only surface or a fenced document pays for
 * no menu.
 */
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
