import type { Mark } from "@tiptap/pm/model";

import type { LinkAnchor } from "./link-commands";
import type { InternalLinkNavigator } from "./link-navigation";
import type { LinkTarget } from "./link-target";

export type LinkPoint = { x: number; y: number };

export type LinkRange = { from: number; to: number };

export type LinkHint = {
  element: HTMLElement;
  target: LinkTarget;
  ref: string | null;
};

export type LinkFormRequest = {
  at: LinkPoint;
  seq: number;
};

export type LinkMenuTarget = {
  anchor: LinkAnchor;
  href: string;
  ref: string | null;
  target: LinkTarget | null;
  identity: Mark;
};

export type LinkMenuRequest = LinkMenuTarget & {
  at: LinkPoint;
  seq: number;
};

export function linkMenuRange(menu: LinkMenuTarget): LinkRange {
  return { from: menu.anchor.from, to: menu.anchor.to };
}

export type LinkFollowOutcome = {
  state: "checking" | "failed" | "missing";
  target: LinkTarget;
  address: string | null;
};

export type LinkFolderRequest = { folderId: string; at: LinkPoint; seq: number };

export type FollowHandlers = { dismiss: () => void; retry: () => void };

export type LinkSurfaceState = {
  hint: LinkHint | null;
  form: LinkFormRequest | null;
  menu: LinkMenuRequest | null;
  folder: LinkFolderRequest | null;
  follow: LinkFollowOutcome | null;
};

export type LinkSurface = {
  readonly state: LinkSurfaceState;
  subscribe: (listener: () => void) => () => void;

  showHint: (hint: LinkHint | null) => void;
  openForm: (at: LinkPoint) => void;
  closeForm: () => void;
  openMenu: (request: LinkMenuTarget & { at: LinkPoint }) => void;
  retargetMenu: (target: LinkMenuTarget | null) => void;
  closeMenu: () => void;

  openFolder: (request: { folderId: string; at: LinkPoint }) => void;
  closeFolder: () => void;

  reportFollow: (outcome: LinkFollowOutcome) => void;
  clearFollow: () => void;
  dismissFollow: () => void;
  retryFollow: () => void;
  registerFollowHandlers: (handlers: FollowHandlers) => () => void;

  readonly navigator: InternalLinkNavigator | null;
  registerNavigator: (navigate: InternalLinkNavigator) => () => void;

  readonly dragSource: LinkDragSource | null;
  registerDragSource: (source: LinkDragSource) => () => void;

  destroy: () => void;
};

const EMPTY_STATE: LinkSurfaceState = {
  hint: null,
  form: null,
  menu: null,
  folder: null,
  follow: null,
};

export type LinkDragSource = (request: {
  entry: { kind: "file" | "folder"; id: string };
  name: string;
  event: DragEvent;
}) => void;

export function createLinkSurface(): LinkSurface {
  const listeners = new Set<() => void>();
  let state = EMPTY_STATE;
  let navigator: InternalLinkNavigator | null = null;
  let dragSource: LinkDragSource | null = null;
  let followHandlers: FollowHandlers | null = null;
  let sequence = 0;

  const set = (next: Partial<LinkSurfaceState>) => {
    const merged = { ...state, ...next };
    if (
      merged.hint === state.hint &&
      merged.form === state.form &&
      merged.menu === state.menu &&
      merged.folder === state.folder &&
      merged.follow === state.follow
    ) {
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
      set({ form: { at, seq: sequence }, menu: null, folder: null, hint: null });
    },
    closeForm() {
      set({ form: null });
    },

    openMenu(request) {
      sequence += 1;
      set({ menu: { ...request, seq: sequence }, form: null, folder: null, hint: null });
    },
    retargetMenu(target) {
      if (!state.menu) return;
      set({ menu: target && { ...state.menu, ...target } });
    },
    closeMenu() {
      set({ menu: null });
    },

    openFolder(request) {
      sequence += 1;
      set({ folder: { ...request, seq: sequence }, menu: null, form: null, hint: null });
    },
    closeFolder() {
      set({ folder: null });
    },

    reportFollow(outcome) {
      set({ follow: outcome });
    },
    clearFollow() {
      set({ follow: null });
    },
    dismissFollow() {
      if (followHandlers) followHandlers.dismiss();
      else set({ follow: null });
    },
    retryFollow() {
      followHandlers?.retry();
    },
    registerFollowHandlers(handlers) {
      followHandlers = handlers;
      return () => {
        if (followHandlers === handlers) followHandlers = null;
      };
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

    get dragSource() {
      return dragSource;
    },
    registerDragSource(source) {
      dragSource = source;
      return () => {
        if (dragSource === source) dragSource = null;
      };
    },

    destroy() {
      listeners.clear();
      navigator = null;
      dragSource = null;
      followHandlers = null;
      state = EMPTY_STATE;
    },
  };
}
