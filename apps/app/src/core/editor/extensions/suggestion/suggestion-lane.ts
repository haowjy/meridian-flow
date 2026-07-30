/**
 * One mechanism for every menu the writer types underneath, reading a spec.
 *
 * `/` and `[[` are the same machine with different envelopes: a plugin key, a
 * store in extension storage, a `@tiptap/suggestion` lifecycle, arrow keys
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
 * - **Own Escape.** The chrome kernel does (`escStep`), and it runs first at
 *   priority 1050; a menu takes its step by being a registered layer, which the
 *   React surface does when it opens. Suggestion's own Escape handling stays as
 *   the floor under that, for the frame before React has rendered.
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
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuController,
  type SuggestionMenuSession,
} from "@/core/completion";
import { getEditorChrome } from "../../chrome";

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
};

/**
 * A lane's own answers. `TItem` is what matched the query; `TEntry` is how the
 * menu shows it, which is the same thing until a lane has something to say about
 * a row that the query cannot answer (the slash menu's refusals).
 */
export type SuggestionLaneSpec<TCatalog, TItem, TEntry extends TItem = TItem, TMeta = null> = {
  /** Extension name, storage key, and the plugin key's name. */
  name: string;
  /** The text that opens the menu: `/`, `[[`, `@`. */
  char: string;
  /**
   * Whether the query may carry spaces. On for a lane matching names a writer
   * wrote (document titles have spaces in them); off for a closed vocabulary,
   * where the first space means the writer moved on.
   */
  allowSpaces?: boolean;
  /** Kernel keymap id for the lane's arrow keys, and what diagnostics show. */
  keymapId: string;
  /** The listbox's accessible name, from the catalog that carries the locale. */
  label: (catalog: TCatalog) => string;
  /**
   * The whole envelope, as the lane's own pure predicate over the document.
   * `from` is the position of the trigger text itself. Being offered a catalog
   * at all is asked separately, so a lane's rule stays readable on its own.
   */
  allows: (doc: PMNode, from: number) => boolean;
  /** What matched what the writer has typed after the trigger. */
  items: (catalog: TCatalog, query: string) => readonly TItem[];
  /**
   * How the visible list reads where the caret is — per-row state that depends
   * on the document rather than the query. Asked once per update, so every row
   * is judged against the same document a pick would act on. Absent means the
   * rows ARE the matches.
   */
  entries?: (input: {
    editor: Editor;
    catalog: TCatalog;
    range: Range;
    items: readonly TItem[];
  }) => readonly TEntry[];
  /** Rows this lane will refuse (law 5). Absent means every row works. */
  choosable?: (entry: TEntry) => boolean;
  /** What the menu needs that a row does not carry. Absent means nothing. */
  meta?: (catalog: TCatalog) => TMeta;
  /** What a choice writes into the document, over the trigger's own range. */
  choose: (input: { editor: Editor; catalog: TCatalog; range: Range; entry: TEntry }) => void;
};

export type SuggestionLane<TCatalog, TEntry, TMeta = null> = {
  extension: Extension<SuggestionLaneOptions<TCatalog>>;
  /**
   * The open menu for this editor, or null on a surface that never mounted the
   * lane (a code file, a read-only viewer). Null is a real state.
   */
  getMenu: (editor: Editor | null | undefined) => SuggestionMenu<TEntry, TMeta> | null;
};

export function createSuggestionLane<TCatalog, TItem, TEntry extends TItem = TItem, TMeta = null>(
  spec: SuggestionLaneSpec<TCatalog, TItem, TEntry, TMeta>,
): SuggestionLane<TCatalog, TEntry, TMeta> {
  const pluginKey = new PluginKey(spec.name);
  const catalogFencePluginKey = new PluginKey(`${spec.name}CatalogFence`);

  type LaneStorage = {
    menu: SuggestionMenu<TEntry, TMeta>;
    /** @internal driven by this lane's plugin only. */
    controller: SuggestionMenuController<TEntry, TMeta>;
  };

  const extension = Extension.create<SuggestionLaneOptions<TCatalog>, LaneStorage>({
    name: spec.name,

    addOptions() {
      return { catalog: () => null };
    },

    addStorage(): LaneStorage {
      return createSuggestionMenu<TEntry, TMeta>();
    },

    addProseMirrorPlugins() {
      const editor = this.editor;
      const options = this.options;
      const { menu, controller } = this.storage;

      const sessionFrom = (
        props: SuggestionProps<TItem, TEntry>,
      ): SuggestionMenuSession<TEntry, TMeta> | null => {
        const catalog = options.catalog();
        if (!catalog) return null;
        const entries = spec.entries
          ? spec.entries({ editor, catalog, range: props.range, items: props.items })
          : // No projection means this lane's rows ARE its matches, which is
            // exactly what `TEntry = TItem` says. A defaulted type parameter is
            // not something the compiler can read that off of, so the identity
            // is asserted here rather than made every lane's boilerplate.
            (props.items as unknown as readonly TEntry[]);
        return {
          items: entries,
          query: props.query,
          anchorRect: props.clientRect ?? (() => null),
          label: spec.label(catalog),
          meta: (spec.meta?.(catalog) ?? null) as TMeta,
          choose: (entry) => props.command(entry),
          choosable: spec.choosable,
          dismiss: () => exitSuggestion(editor.view, pluginKey),
        };
      };

      return [
        Suggestion<TItem, TEntry>({
          editor,
          pluginKey,
          char: spec.char,
          allowSpaces: spec.allowSpaces ?? false,
          // The envelope is the lane predicate's, not the plugin's:
          // `startOfLine` and `allowedPrefixes` would express part of a rule in
          // configuration and leave the rest in code, which is how the old slash
          // trigger ended up with rules nobody could read.
          startOfLine: false,
          allowedPrefixes: null,
          allow: ({ state, range }) =>
            options.catalog() !== null && spec.allows(state.doc, range.from),
          items: ({ query }) => {
            const catalog = options.catalog();
            return catalog ? [...spec.items(catalog, query)] : [];
          },
          command: ({ editor: target, range, props }) => {
            const catalog = options.catalog();
            // Withdrawn between the row being drawn and the row being chosen:
            // take the menu down rather than write from a dead list.
            if (!catalog) {
              exitSuggestion(target.view, pluginKey);
              return;
            }
            spec.choose({ editor: target, catalog, range, entry: props });
          },
          render: () => {
            let releaseKeymap: (() => void) | null = null;

            return {
              onStart(props) {
                const session = sessionFrom(props);
                if (!session) return;
                controller.open(session);

                // Registered here rather than from the surface's effect: the
                // menu is on screen the instant the trigger text lands, and a
                // writer who types it and ArrowDown in one motion must not
                // out-run React.
                releaseKeymap =
                  getEditorChrome(editor)?.registerKeymap({
                    id: spec.keymapId,
                    scope: "layer",
                    // No token to name: this runs a beat before React opens the
                    // popover that becomes this menu's layer, which is the
                    // point of registering here. The keys are then the
                    // shallowest rung of layer scope, and an open layer that
                    // claims the same chord answers it instead.
                    layer: null,
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

        // The catalog can be withdrawn without a transaction to notice it: a
        // schema fence or a read-only host flips editability, and `setEditable`
        // re-runs plugin VIEWS rather than plugin `apply`. Suggestion would keep
        // an open menu whose every row is dead, which is the control law 5
        // forbids. Exiting here means withdrawal leaves by the same door as
        // Escape, so the keymap and the chrome layer are released once.
        new Plugin({
          key: catalogFencePluginKey,
          view: (view) => ({
            update() {
              if (!pluginKey.getState(view.state)?.active) return;
              if (options.catalog() === null) exitSuggestion(view, pluginKey);
            },
          }),
        }),
      ];
    },
  });

  const getMenu = (editor: Editor | null | undefined): SuggestionMenu<TEntry, TMeta> | null => {
    if (!editor || editor.isDestroyed) return null;
    // TipTap's storage registry is keyed by extension-name literals, and a lane
    // brings its name at runtime. The cast is the price of one mechanism
    // serving every lane; the shape is this factory's own `addStorage`.
    const storage = editor.storage as unknown as Record<string, LaneStorage | undefined>;
    return storage[spec.name]?.menu ?? null;
  };

  // The plugin key stays inside: a lane's open state is read through its menu,
  // and a returned key is an invitation to read the plugin's state instead.
  return { extension, getMenu };
}
