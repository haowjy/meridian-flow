/**
 * The link lane's per-editor store: which link is being approached, and which
 * of its two summoned surfaces is open.
 *
 * Headless and editor-free, like the chrome kernel's own store. The extension
 * beside it turns pointers and keys into these calls; React reads the state
 * with `useSyncExternalStore` and renders. Nothing here touches the document,
 * so the whole surface policy is testable as data.
 *
 * The hint is approach chrome and the other two are summoned surfaces, so they
 * are separate fields rather than one "current surface": a hover that lands
 * while a menu is open must not close the menu, and a menu that opens must not
 * have to remember to clear a hint.
 */

import type { InternalLinkNavigator } from "./link-navigation";
import type { LinkTarget } from "./link-target";

export type LinkPoint = { x: number; y: number };

export type LinkRange = { from: number; to: number };

/** The destination hint (§5.5): quiet, on approach, never in the way. */
export type LinkHint = {
  /** The rendered anchor, so the hint travels with it as the pane scrolls. */
  element: HTMLElement;
  target: LinkTarget;
};

/** The Ctrl+K form. One field over a selection, two at a bare caret (law 5). */
export type LinkFormRequest = {
  at: LinkPoint;
  /**
   * Bumped on every open so a form summoned twice at the same coordinates is
   * still a new form. Radix positions against a fixed anchor through
   * floating-ui, which never sees one move, so the surface is keyed on this.
   */
  seq: number;
};

/** The right-click menu, on the link the pointer hit rather than the caret. */
export type LinkMenuRequest = {
  at: LinkPoint;
  range: LinkRange;
  href: string;
  target: LinkTarget | null;
  seq: number;
};

export type LinkSurfaceState = {
  hint: LinkHint | null;
  form: LinkFormRequest | null;
  menu: LinkMenuRequest | null;
};

export type LinkSurface = {
  readonly state: LinkSurfaceState;
  subscribe: (listener: () => void) => () => void;

  showHint: (hint: LinkHint | null) => void;
  openForm: (at: LinkPoint) => void;
  closeForm: () => void;
  openMenu: (request: Omit<LinkMenuRequest, "seq">) => void;
  closeMenu: () => void;

  /**
   * Where an internal link goes. Absent is a real state, not a bug: until the
   * app registers one, internal links have no destination the editor can
   * reach, so the Open verb is absent rather than dead (law 5).
   */
  readonly navigator: InternalLinkNavigator | null;
  registerNavigator: (navigate: InternalLinkNavigator) => () => void;

  destroy: () => void;
};

const EMPTY_STATE: LinkSurfaceState = { hint: null, form: null, menu: null };

export function createLinkSurface(): LinkSurface {
  const listeners = new Set<() => void>();
  let state = EMPTY_STATE;
  let navigator: InternalLinkNavigator | null = null;
  let sequence = 0;

  const set = (next: Partial<LinkSurfaceState>) => {
    const merged = { ...state, ...next };
    if (merged.hint === state.hint && merged.form === state.form && merged.menu === state.menu) {
      return;
    }
    state = merged;
    for (const listener of listeners) listener();
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    showHint(hint) {
      if (hint && state.hint?.element === hint.element) return;
      set({ hint });
    },

    openForm(at) {
      sequence += 1;
      // The two summoned surfaces are alternatives, never neighbours: Edit
      // link opens the form from the menu, and leaving the menu up behind it
      // would put two claims on the same link (law 4).
      set({ form: { at, seq: sequence }, menu: null, hint: null });
    },
    closeForm() {
      set({ form: null });
    },

    openMenu(request) {
      sequence += 1;
      set({ menu: { ...request, seq: sequence }, form: null, hint: null });
    },
    closeMenu() {
      set({ menu: null });
    },

    get navigator() {
      return navigator;
    },
    registerNavigator(navigate) {
      navigator = navigate;
      return () => {
        if (navigator === navigate) navigator = null;
      };
    },

    destroy() {
      listeners.clear();
      navigator = null;
      state = EMPTY_STATE;
    },
  };
}
