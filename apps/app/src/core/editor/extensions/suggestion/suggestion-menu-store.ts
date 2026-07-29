/**
 * The open menu a writer types underneath, headless.
 *
 * Two triggers have these physics: `/` offering blocks (§5.7) and `[[`
 * offering documents (§5.5). In both the query IS the document text after the
 * trigger, the caret never leaves the prose, and `@tiptap/suggestion` owns when
 * the menu exists and what matched. This store is the whole seam between that
 * plugin and React, which is why the keyboard lives here rather than in the
 * component: the arrow keys are registered against the chrome kernel from the
 * plugin's own lifetime, so they are bound before React has rendered a single
 * row and the first ArrowDown after the trigger cannot miss.
 *
 * The menu is only `open` while it has something to offer. A filter that
 * matches nothing leaves the trigger active — backspacing brings the list
 * back — but shows no surface, because a menu with no rows is the dead control
 * law 5 forbids.
 *
 * `TMeta` is whatever a lane's rows need that is not a row: the slash menu's
 * group labels, say. Anything a lane reads on every row belongs in `TItem`.
 */

export type SuggestionMenuSnapshot<TItem, TMeta = null> = {
  open: boolean;
  items: readonly TItem[];
  activeIndex: number;
  /** What the writer has typed after the trigger. */
  query: string;
  /** Live rect of the trigger in the text, for a surface that must follow it. */
  anchorRect: (() => DOMRect | null) | null;
  label: string;
  meta: TMeta | null;
};

/** Everything the trigger knows when it opens or refilters the menu. */
export type SuggestionMenuSession<TItem, TMeta = null> = {
  items: readonly TItem[];
  query: string;
  anchorRect: () => DOMRect | null;
  label: string;
  meta: TMeta;
  /** Applies the choice; the trigger consumes its own text and the query. */
  choose: (item: TItem) => void;
  /** Leaves the typed text alone and takes the menu down. */
  dismiss: () => void;
};

export type SuggestionMenu<TItem, TMeta = null> = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => SuggestionMenuSnapshot<TItem, TMeta>;
  setActiveIndex: (index: number) => void;
  /** Arrow keys. Returns false when there is nothing to move through. */
  move: (delta: number) => boolean;
  choose: (index: number) => boolean;
  chooseActive: () => boolean;
  dismiss: () => void;
};

/** @internal driven by a suggestion plugin only. */
export type SuggestionMenuController<TItem, TMeta = null> = {
  open: (session: SuggestionMenuSession<TItem, TMeta>) => void;
  update: (session: SuggestionMenuSession<TItem, TMeta>) => void;
  close: () => void;
};

const CLOSED = Object.freeze({
  open: false,
  items: Object.freeze([]),
  activeIndex: 0,
  query: "",
  anchorRect: null,
  label: "",
  meta: null,
});

/** The shared "no menu" reading, so a surface's fallback is never a new object. */
export function closedSuggestionMenu<TItem, TMeta = null>(): SuggestionMenuSnapshot<TItem, TMeta> {
  return CLOSED as SuggestionMenuSnapshot<TItem, TMeta>;
}

export function createSuggestionMenu<TItem, TMeta = null>(): {
  menu: SuggestionMenu<TItem, TMeta>;
  controller: SuggestionMenuController<TItem, TMeta>;
} {
  const listeners = new Set<() => void>();
  let session: SuggestionMenuSession<TItem, TMeta> | null = null;
  let activeIndex = 0;
  let snapshot: SuggestionMenuSnapshot<TItem, TMeta> = closedSuggestionMenu();

  const publish = () => {
    snapshot = session
      ? {
          open: session.items.length > 0,
          items: session.items,
          activeIndex,
          query: session.query,
          anchorRect: session.anchorRect,
          label: session.label,
          meta: session.meta,
        }
      : closedSuggestionMenu();
    for (const listener of listeners) listener();
  };

  const menu: SuggestionMenu<TItem, TMeta> = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,

    setActiveIndex(index) {
      if (!session || index < 0 || index >= session.items.length || index === activeIndex) return;
      activeIndex = index;
      publish();
    },

    move(delta) {
      const count = session?.items.length ?? 0;
      if (count === 0) return false;
      activeIndex = (activeIndex + delta + count) % count;
      publish();
      return true;
    },

    choose(index) {
      const item = session?.items[index];
      if (!session || !item) return false;
      session.choose(item);
      return true;
    },

    chooseActive() {
      return menu.choose(activeIndex);
    },

    dismiss() {
      session?.dismiss();
    },
  };

  const controller: SuggestionMenuController<TItem, TMeta> = {
    open(next) {
      session = next;
      activeIndex = 0;
      publish();
    },
    // A refilter is a new list, so the highlight goes back to the top: the
    // best match for what the writer just typed is the one they meant.
    update(next) {
      session = next;
      activeIndex = 0;
      publish();
    },
    close() {
      if (!session) return;
      session = null;
      activeIndex = 0;
      publish();
    },
  };

  return { menu, controller };
}
