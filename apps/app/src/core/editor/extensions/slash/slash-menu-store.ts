/**
 * The open menu, headless.
 *
 * `@tiptap/suggestion` owns when the menu exists and what matched; React owns
 * how it looks. This store is the whole seam between them, which is why the
 * keyboard lives here rather than in the component: the arrow keys are
 * registered against the chrome kernel from the plugin's own lifetime, so they
 * are bound before React has rendered a single row and the first ArrowDown
 * after `/` cannot miss.
 *
 * The menu is only `open` while it has something to offer. A filter that
 * matches nothing leaves the trigger active — backspacing brings the list
 * back — but shows no surface, because a menu with no rows is the dead
 * control law 5 forbids.
 */

import type { SlashCommandGroupId, SlashCommandItem } from "./slash-catalog";

export type SlashMenuSnapshot = {
  open: boolean;
  items: readonly SlashCommandItem[];
  activeIndex: number;
  /** What the writer has typed after the `/`. Empty means "show the groups". */
  query: string;
  /** Live rect of the `/` in the text, for a surface that must follow it. */
  anchorRect: (() => DOMRect | null) | null;
  label: string;
  groupLabels: Record<SlashCommandGroupId, string> | null;
};

/** Everything the trigger knows when it opens or refilters the menu. */
export type SlashMenuSession = {
  items: readonly SlashCommandItem[];
  query: string;
  anchorRect: () => DOMRect | null;
  label: string;
  groupLabels: Record<SlashCommandGroupId, string>;
  /** Applies the choice; the trigger consumes the `/` and its filter text. */
  choose: (item: SlashCommandItem) => void;
  /** Leaves the typed text alone and takes the menu down. */
  dismiss: () => void;
};

export type SlashMenu = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => SlashMenuSnapshot;
  setActiveIndex: (index: number) => void;
  /** Arrow keys. Returns false when there is nothing to move through. */
  move: (delta: number) => boolean;
  choose: (index: number) => boolean;
  chooseActive: () => boolean;
  dismiss: () => void;
};

/** @internal driven by the suggestion plugin only. */
export type SlashMenuController = {
  open: (session: SlashMenuSession) => void;
  update: (session: SlashMenuSession) => void;
  close: () => void;
};

const CLOSED: SlashMenuSnapshot = Object.freeze({
  open: false,
  items: Object.freeze([]),
  activeIndex: 0,
  query: "",
  anchorRect: null,
  label: "",
  groupLabels: null,
});

export function createSlashMenu(): { menu: SlashMenu; controller: SlashMenuController } {
  const listeners = new Set<() => void>();
  let session: SlashMenuSession | null = null;
  let activeIndex = 0;
  let snapshot: SlashMenuSnapshot = CLOSED;

  const publish = () => {
    snapshot = session
      ? {
          open: session.items.length > 0,
          items: session.items,
          activeIndex,
          query: session.query,
          anchorRect: session.anchorRect,
          label: session.label,
          groupLabels: session.groupLabels,
        }
      : CLOSED;
    for (const listener of listeners) listener();
  };

  const menu: SlashMenu = {
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

  const controller: SlashMenuController = {
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
