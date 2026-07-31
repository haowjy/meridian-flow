/**
 * The open menu a writer types underneath, headless.
 *
 * Two triggers have these physics today: `/` offering blocks (§5.7) and `[[`
 * offering documents (§5.5). In both the query IS the text after the trigger,
 * the caret never leaves what the writer is typing, and something upstream owns
 * when the menu exists and what matched — `@tiptap/suggestion` in the editor,
 * caret measurement in a composer. This store is the whole seam between that
 * upstream and React, which is why the keyboard lives here rather than in the
 * component: the arrow keys are registered from the trigger's own lifetime, so
 * they are bound before React has rendered a single row and the first ArrowDown
 * after the trigger cannot miss.
 *
 * The menu is only `open` while it has something to offer. A filter that
 * matches nothing leaves the trigger active — backspacing brings the list
 * back — but shows no surface, because a menu with no rows is the dead control
 * law 5 forbids.
 *
 * A row that is visible but cannot be chosen is the other half of law 5, and
 * the store is where "cannot" has to live: the highlight steps over such rows
 * and Enter declines them, so a lane can show a writer why an entry refuses
 * without ever handing them a key that does nothing. A lane with no such rows
 * passes no `choosable` and nothing changes.
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
  /** Rows this lane will refuse. Absent means every row works. */
  choosable?: (item: TItem) => boolean;
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

  const choosable = (index: number) => {
    const item = session?.items[index];
    return item !== undefined && (session?.choosable?.(item) ?? true);
  };

  /** The row the highlight opens on: the first the lane will take, or none at all. */
  const firstChoosable = () => {
    const count = session?.items.length ?? 0;
    for (let index = 0; index < count; index += 1) if (choosable(index)) return index;
    return -1;
  };

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
      if (!session || index === activeIndex || !choosable(index)) return;
      activeIndex = index;
      publish();
    },

    move(delta) {
      const count = session?.items.length ?? 0;
      if (count === 0) return false;
      // Steps over rows the lane refuses, so the key never lands somewhere
      // Enter would decline. All of them refusing means the key is not ours,
      // and that is the only way the highlight is nowhere (-1) to begin with.
      for (let step = 1; step <= count; step += 1) {
        const candidate = (((activeIndex + delta * step) % count) + count) % count;
        if (!choosable(candidate)) continue;
        activeIndex = candidate;
        publish();
        return true;
      }
      return false;
    },

    choose(index) {
      const item = session?.items[index];
      if (!session || !item || !choosable(index)) return false;
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
      activeIndex = firstChoosable();
      publish();
    },
    // A refilter is a new list, so the highlight goes back to the top: the
    // best match for what the writer just typed is the one they meant.
    update(next) {
      session = next;
      activeIndex = firstChoosable();
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
