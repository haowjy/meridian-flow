/**
 * Activity toast registry: the keyed store behind the app-wide `ToastRegion`.
 *
 * Any owner (an import, an export) registers a toast under its own key and
 * supplies its own content; the registry knows nothing about what the toast is
 * for. The registry holds order (oldest first, an update keeps its place),
 * which cards the writer collapsed (for the life of the tab), and which toasts
 * the region actually has on screen in a visible tab. Owners read that last
 * fact with `useToastVisible` to time things like a clean "Done" closing itself.
 *
 * An owner whose content needs its own React context (a project's Undo
 * notices) registers a slot instead (`useToastSlot`): the region places it like
 * any toast (order, "+N more", seen) and hands back the element to portal into.
 *
 * One registry per authenticated tree (`ToastRegistryProvider`); tests build
 * their own with `createToastRegistry`. The provider also holds the elements
 * the desktop region rises above rather than covers (`useToastClearance`).
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

export type ActivityToastSpec = {
  /** The toast's name: its one line when collapsed, and the bar's accessible name. */
  title: string;
  /** A fact line under the title. */
  detail?: ReactNode;
  /** 0 to 100, or "indeterminate". Omit when nothing is running. */
  progress?: number | "indeterminate";
  /** Buttons for the actions row. */
  actions?: ReactNode;
  /** Extra body between the bar and the actions (for example a list of problems). */
  children?: ReactNode;
  /** Close control. Omit it and the card has none (a decision the writer must make). */
  onClose?: () => void;
  slot?: never;
};

/** An entry its owner renders itself (`useToastSlot`); the region only places it. */
type ToastSlotSpec = { slot: true };
const SLOT: ToastSlotSpec = { slot: true };

export type ActivityCardToast = ActivityToastSpec & { key: string };
export type ActivityToast = ActivityCardToast | (ToastSlotSpec & { key: string });

export const isCardToast = (toast: ActivityToast): toast is ActivityCardToast => !toast.slot;

type Snapshot = {
  /** Oldest first. The region shows the tail. */
  toasts: readonly ActivityToast[];
  collapsed: ReadonlySet<string>;
  /** Toasts on screen right now in a visible tab. */
  visible: ReadonlySet<string>;
  /** Increments when an owner asks for a toast to be brought forward. */
  revealRequest: number;
  /** Each slot's element while the region has it on screen. */
  hosts: ReadonlyMap<string, HTMLElement>;
};

export type ToastRegistry = ReturnType<typeof createToastRegistry>;

export function createToastRegistry() {
  let snapshot: Snapshot = {
    toasts: [],
    collapsed: new Set(),
    visible: new Set(),
    revealRequest: 0,
    hosts: new Map(),
  };
  const listeners = new Set<() => void>();
  const commit = (next: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,

    /** Registers the toast, or replaces its content in place. */
    show(key: string, spec: ActivityToastSpec | ToastSlotSpec) {
      const at = snapshot.toasts.findIndex((toast) => toast.key === key);
      const toast = { ...spec, key };
      commit({
        toasts:
          at < 0
            ? [...snapshot.toasts, toast]
            : snapshot.toasts.map((existing, i) => (i === at ? toast : existing)),
      });
    },
    /** Merges into a registered toast; does nothing when it is gone. */
    update(key: string, patch: Partial<ActivityToastSpec>) {
      if (!snapshot.toasts.some((toast) => toast.key === key)) return;
      commit({
        toasts: snapshot.toasts.map((toast) =>
          toast.key === key && isCardToast(toast) ? { ...toast, ...patch } : toast,
        ),
      });
    },
    remove(key: string) {
      if (!snapshot.toasts.some((toast) => toast.key === key)) return;
      const collapsed = new Set(snapshot.collapsed);
      collapsed.delete(key);
      commit({ toasts: snapshot.toasts.filter((toast) => toast.key !== key), collapsed });
    },
    /** Brings the toast forward: newest slot, expanded; the phone opens its sheet. */
    reveal(key: string) {
      const toast = snapshot.toasts.find((candidate) => candidate.key === key);
      if (!toast) return;
      const collapsed = new Set(snapshot.collapsed);
      collapsed.delete(key);
      commit({
        toasts: [...snapshot.toasts.filter((candidate) => candidate !== toast), toast],
        collapsed,
        revealRequest: snapshot.revealRequest + 1,
      });
    },

    setCollapsed(key: string, collapsed: boolean) {
      if (snapshot.collapsed.has(key) === collapsed) return;
      const next = new Set(snapshot.collapsed);
      if (collapsed) next.add(key);
      else next.delete(key);
      commit({ collapsed: next });
    },
    /** The region reports what it has on screen. Not for owners. */
    reportVisible(keys: ReadonlySet<string>) {
      const same =
        keys.size === snapshot.visible.size && [...keys].every((key) => snapshot.visible.has(key));
      if (!same) commit({ visible: keys });
    },
    /** The region mounts or drops a slot's element. Not for owners. */
    setHost(key: string, host: HTMLElement | null) {
      if ((snapshot.hosts.get(key) ?? null) === host) return;
      const hosts = new Map(snapshot.hosts);
      if (host) hosts.set(key, host);
      else hosts.delete(key);
      commit({ hosts });
    },
  };
}

const ToastRegistryContext = createContext<ToastRegistry | null>(null);

type RegionLayout = {
  clearances: ReadonlySet<HTMLElement>;
  clear: (element: HTMLElement) => () => void;
};
const RegionLayoutContext = createContext<RegionLayout | null>(null);

export function ToastRegistryProvider({
  registry,
  children,
}: {
  /** Tests pass their own; the app lets the provider own one for its lifetime. */
  registry?: ToastRegistry;
  children: ReactNode;
}) {
  const [owned] = useState(createToastRegistry);
  const [clearances, setClearances] = useState<ReadonlySet<HTMLElement>>(() => new Set());
  const clear = useCallback((element: HTMLElement) => {
    setClearances((current) => new Set(current).add(element));
    return () =>
      setClearances((current) => {
        const next = new Set(current);
        next.delete(element);
        return next;
      });
  }, []);
  const layout = useMemo(() => ({ clearances, clear }), [clearances, clear]);
  return (
    <ToastRegistryContext.Provider value={registry ?? owned}>
      <RegionLayoutContext.Provider value={layout}>{children}</RegionLayoutContext.Provider>
    </ToastRegistryContext.Provider>
  );
}

/** The elements the desktop region rises above. */
export function useToastRegionLayout(): RegionLayout {
  const layout = useContext(RegionLayoutContext);
  if (!layout) throw new Error("useToastRegionLayout needs a ToastRegistryProvider above it.");
  return layout;
}

/**
 * A ref that keeps the desktop region from covering its element (the pinned chat
 * composer): while the element is mounted, the region rises above it whenever
 * they would overlap. A callback ref, so a replaced element is followed.
 */
export function useToastClearance(): (element: HTMLElement | null) => () => void {
  const { clear } = useToastRegionLayout();
  return useCallback(
    (element: HTMLElement | null) => (element ? clear(element) : () => {}),
    [clear],
  );
}

/** The registry for imperative owners: `show`, `update`, `remove`, `reveal`. */
export function useToastRegistry(): ToastRegistry {
  const registry = useContext(ToastRegistryContext);
  if (!registry) throw new Error("useToastRegistry needs a ToastRegistryProvider above it.");
  return registry;
}

export function useToastSnapshot(): Snapshot {
  const registry = useToastRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

/**
 * Keeps a toast registered while the calling component renders `spec`, and
 * removes it when `spec` is null or the component unmounts. A change of `key`
 * removes the old toast.
 */
export function useActivityToast(key: string, spec: ActivityToastSpec | null): void {
  const registry = useToastRegistry();
  useEffect(() => {
    if (spec) registry.show(key, spec);
    else registry.remove(key);
  }, [registry, key, spec]);
  useEffect(() => () => registry.remove(key), [registry, key]);
}

/**
 * Keeps a slot registered while `key` is non-null and the caller is mounted, and
 * returns the element to portal its content into: null while the region has it
 * folded into "+N more" (or before it mounts). For content that needs the
 * caller's React context; `useToastVisible` works for slots too.
 */
export function useToastSlot(key: string | null): HTMLElement | null {
  const registry = useToastRegistry();
  useEffect(() => {
    if (!key) return;
    registry.show(key, SLOT);
    return () => registry.remove(key);
  }, [registry, key]);
  return useSyncExternalStore(
    registry.subscribe,
    () => (key ? (registry.getSnapshot().hosts.get(key) ?? null) : null),
    () => null,
  );
}

/**
 * True while the region has this toast on screen (expanded or collapsed, not
 * folded into "+N more" or "N in progress") and the browser tab is visible.
 * An owner starts its "seen for 6 seconds" timer on true and cancels it on false.
 */
export function useToastVisible(key: string): boolean {
  const registry = useToastRegistry();
  // A boolean snapshot: the owner re-renders only when its own toast flips, so
  // an owner that also registers the toast on every render cannot loop.
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.getSnapshot().visible.has(key),
    () => false,
  );
}

/** Layout reserves space for the phone bar without subscribing to progress ticks. */
export function useHasActivityToast(): boolean {
  const registry = useToastRegistry();
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.getSnapshot().toasts.length > 0,
    () => false,
  );
}
