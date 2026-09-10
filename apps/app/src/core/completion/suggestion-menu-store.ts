/**
 * The host-independent lifecycle for a menu the writer types underneath.
 *
 * A host opens one session, advances its generation before starting work, and
 * publishes an update only with the returned identity. Arrival order is thus
 * irrelevant: an update from an old generation or closed session is refused.
 * This owner also publishes the external-store snapshot, invokes host callbacks,
 * and keeps selection attached to a stable row ID across catalog refreshes.
 */

export type InternalSuggestionSessionId = string;
export type InternalSuggestionGeneration = Readonly<{
  sessionId: InternalSuggestionSessionId;
  generation: number;
}>;
export type SuggestionSelectionPolicy = "reset" | "preserve-active";
export type SuggestionChoiceAction = "enter" | "tab";
export type SuggestionKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "Enter" | "Tab";
export type SuggestionKeyBindings = Readonly<Partial<Record<SuggestionKey, () => boolean>>>;

export type SuggestionRetreat = {
  /** Move one level toward the root. False means this session is already at its root. */
  backtrack: () => boolean;
  /** Close the root suggestion without prescribing which physical key caused it. */
  dismiss: () => void;
};

/** One host registration owns ordinary keys and semantic retreat together. */
export type SuggestionHostLease = {
  release: () => void;
};

/** The host-neutral interaction capability a suggestion adapter consumes. */
export type SuggestionHost = {
  register: (input: {
    id: string;
    bindings: SuggestionKeyBindings;
    retreat: SuggestionRetreat;
  }) => SuggestionHostLease;
};

export type SuggestionMenuSnapshot<TItem, TMeta = null> = {
  open: boolean;
  items: readonly TItem[];
  /** Stable identity of the highlighted row; array position is presentation only. */
  activeId: string | null;
  activeIndex: number;
  query: string;
  anchorRect: (() => DOMRect | null) | null;
  label: string;
  meta: TMeta | null;
};

export type InternalSuggestionSession<TItem, TMeta = null> = {
  items: readonly TItem[];
  /** Stable within the row's domain, including across catalog refreshes. */
  rowId: (item: TItem) => string;
  query: string;
  anchorRect: () => DOMRect | null;
  label: string;
  meta: TMeta;
  choose: (item: TItem, action: SuggestionChoiceAction) => void;
  choosable?: (item: TItem) => boolean;
  /** Keep loading/empty feedback visible without inventing a selectable row. */
  keepOpenWhenEmpty?: boolean;
  /** Handles Escape within a hierarchical session; false hands it back to the host. */
  backtrack?: () => boolean;
  dismiss: () => void;
};

export type InternalSuggestionLifecycleCallbacks<TItem, TMeta = null> = {
  /**
   * Accepted transitions publish in FIFO order: install their captured
   * snapshot, invoke their lifecycle callback, then notify menu subscribers.
   * A synchronous reentrant transition begins only after all three complete.
   */
  open?: (
    identity: InternalSuggestionGeneration,
    snapshot: SuggestionMenuSnapshot<TItem, TMeta>,
  ) => void;
  update?: (
    identity: InternalSuggestionGeneration,
    snapshot: SuggestionMenuSnapshot<TItem, TMeta>,
  ) => void;
  close?: (identity: InternalSuggestionGeneration) => void;
};

export type SuggestionMenu<TItem, TMeta = null> = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => SuggestionMenuSnapshot<TItem, TMeta>;
  setActiveId: (rowId: string) => void;
  setActiveIndex: (index: number) => void;
  move: (delta: number) => boolean;
  moveTo: (edge: "first" | "last") => boolean;
  choose: (index: number, action?: SuggestionChoiceAction) => boolean;
  chooseActive: (action?: SuggestionChoiceAction) => boolean;
  backtrack: () => boolean;
  dismiss: () => void;
};

/** The single session owner, driven by a trigger or another host. */
export type InternalSuggestionLifecycle<TItem, TMeta = null> = {
  open: (session: InternalSuggestionSession<TItem, TMeta>) => InternalSuggestionGeneration;
  /** Fence all earlier work before starting an async query/context/container update. */
  nextGeneration: (sessionId: InternalSuggestionSessionId) => InternalSuggestionGeneration | null;
  /** Returns false without publishing when the identity is stale. */
  update: (
    identity: InternalSuggestionGeneration,
    session: InternalSuggestionSession<TItem, TMeta>,
    selection: SuggestionSelectionPolicy,
  ) => boolean;
  /** A stale host cannot close a newer session. */
  close: (identity: InternalSuggestionGeneration) => boolean;
};

let nextSuggestionSession = 0;

const CLOSED = Object.freeze({
  open: false,
  items: Object.freeze([]),
  activeId: null,
  activeIndex: 0,
  query: "",
  anchorRect: null,
  label: "",
  meta: null,
});

export function closedSuggestionMenu<TItem, TMeta = null>(): SuggestionMenuSnapshot<TItem, TMeta> {
  return CLOSED as SuggestionMenuSnapshot<TItem, TMeta>;
}

const sameIdentity = (
  left: InternalSuggestionGeneration | null,
  right: InternalSuggestionGeneration | null,
) =>
  left !== null &&
  right !== null &&
  left.sessionId === right.sessionId &&
  left.generation === right.generation;

export function createInternalSuggestionLifecycle<TItem, TMeta = null>(
  callbacks: InternalSuggestionLifecycleCallbacks<TItem, TMeta> = {},
): {
  menu: SuggestionMenu<TItem, TMeta>;
  lifecycle: InternalSuggestionLifecycle<TItem, TMeta>;
} {
  const listeners = new Set<() => void>();
  let identity: InternalSuggestionGeneration | null = null;
  let session: InternalSuggestionSession<TItem, TMeta> | null = null;
  let activeId: string | null = null;
  let snapshot: SuggestionMenuSnapshot<TItem, TMeta> = closedSuggestionMenu();
  let projectedIdentity: InternalSuggestionGeneration | null = null;
  const transitions: Array<() => void> = [];
  let publishing = false;

  const indexOf = (rowId: string | null) =>
    rowId === null || !session
      ? -1
      : session.items.findIndex((item) => session?.rowId(item) === rowId);

  const choosable = (index: number) => {
    const item = session?.items[index];
    return item !== undefined && (session?.choosable?.(item) ?? true);
  };

  const firstChoosableId = () => {
    const count = session?.items.length ?? 0;
    for (let index = 0; index < count; index += 1) {
      const item = session?.items[index];
      if (item !== undefined && choosable(index)) return session?.rowId(item) ?? null;
    }
    return null;
  };

  const publishSnapshot = () => {
    snapshot = session
      ? {
          open: session.items.length > 0 || session.keepOpenWhenEmpty === true,
          items: session.items,
          activeId,
          activeIndex: indexOf(activeId),
          query: session.query,
          anchorRect: session.anchorRect,
          label: session.label,
          meta: session.meta,
        }
      : closedSuggestionMenu();
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const publish = () => {
    publishSnapshot();
    notify();
  };

  // A transition publishes its lifecycle callback and subscribers completely
  // before a synchronous reentrant transition begins. Reentrant calls still
  // return against the projected FIFO state, so their identity is immediately
  // usable even though their mutation waits for the current event to finish.
  const enqueue = (transition: () => void) => {
    transitions.push(transition);
    if (publishing) return;
    publishing = true;
    try {
      while (transitions.length > 0) transitions.shift()?.();
    } finally {
      publishing = false;
    }
  };

  const menu: SuggestionMenu<TItem, TMeta> = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    setActiveId(rowId) {
      const index = indexOf(rowId);
      if (rowId === activeId || !choosable(index)) return;
      activeId = rowId;
      publish();
    },
    setActiveIndex(index) {
      const item = session?.items[index];
      if (item === undefined || !choosable(index)) return;
      menu.setActiveId(session?.rowId(item) ?? "");
    },
    move(delta) {
      const count = session?.items.length ?? 0;
      if (count === 0) return false;
      const activeIndex = indexOf(activeId);
      for (let step = 1; step <= count; step += 1) {
        const candidate = (((activeIndex + delta * step) % count) + count) % count;
        const item = session?.items[candidate];
        if (item === undefined || !choosable(candidate)) continue;
        activeId = session?.rowId(item) ?? null;
        publish();
        return true;
      }
      return false;
    },
    moveTo(edge) {
      const count = session?.items.length ?? 0;
      const start = edge === "first" ? 0 : count - 1;
      const step = edge === "first" ? 1 : -1;
      for (let index = start; index >= 0 && index < count; index += step) {
        const item = session?.items[index];
        if (item === undefined || !choosable(index)) continue;
        activeId = session?.rowId(item) ?? null;
        publish();
        return true;
      }
      return false;
    },
    choose(index, action = "enter") {
      const item = session?.items[index];
      if (!session || item === undefined || !choosable(index)) return false;
      session.choose(item, action);
      return true;
    },
    chooseActive(action = "enter") {
      return menu.choose(indexOf(activeId), action);
    },
    backtrack() {
      return session?.backtrack?.() ?? false;
    },
    dismiss() {
      session?.dismiss();
    },
  };

  const lifecycle: InternalSuggestionLifecycle<TItem, TMeta> = {
    open(next) {
      const opened = Object.freeze({
        sessionId: `suggestion-${++nextSuggestionSession}`,
        generation: 0,
      });
      projectedIdentity = opened;
      enqueue(() => {
        const replaced = identity;
        session = next;
        identity = opened;
        activeId = firstChoosableId();
        publishSnapshot();
        if (replaced) callbacks.close?.(replaced);
        callbacks.open?.(opened, snapshot);
        notify();
      });
      return opened;
    },
    nextGeneration(sessionId) {
      if (!projectedIdentity || projectedIdentity.sessionId !== sessionId) return null;
      const advanced = Object.freeze({
        sessionId,
        generation: projectedIdentity.generation + 1,
      });
      projectedIdentity = advanced;
      enqueue(() => {
        identity = advanced;
      });
      return advanced;
    },
    update(candidate, next, selection) {
      if (!sameIdentity(candidate, projectedIdentity)) {
        return false;
      }
      enqueue(() => {
        const previousActiveId = activeId;
        session = next;
        activeId =
          selection === "preserve-active" && choosable(indexOf(previousActiveId))
            ? previousActiveId
            : firstChoosableId();
        publishSnapshot();
        callbacks.update?.(candidate, snapshot);
        notify();
      });
      return true;
    },
    close(candidate) {
      if (!sameIdentity(candidate, projectedIdentity)) return false;
      projectedIdentity = null;
      enqueue(() => {
        session = null;
        identity = null;
        activeId = null;
        publishSnapshot();
        callbacks.close?.(candidate);
        notify();
      });
      return true;
    },
  };

  return { menu, lifecycle };
}
