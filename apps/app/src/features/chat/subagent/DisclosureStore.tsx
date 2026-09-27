/** Per-chat disclosure state survives transcript virtualization and reveals. */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type Store = {
  values: ReadonlyMap<string, boolean>;
  set: (key: string, value: boolean) => void;
  enabled: boolean;
};
const DisclosureContext = createContext<Store>({
  values: new Map(),
  set: () => {},
  enabled: false,
});
const disclosureSetters = new Map<string, (value: boolean) => void>();

export function revealSubagentDisclosure(key: string) {
  disclosureSetters.get(key)?.(true);
}

export function SubagentDisclosureProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const set = useCallback(
    (key: string, value: boolean) =>
      setValues((current) => {
        if (current.get(key) === value) return current;
        const next = new Map(current);
        next.set(key, value);
        return next;
      }),
    [],
  );
  const store = useMemo(() => ({ values, set, enabled: true }), [values, set]);
  return <DisclosureContext.Provider value={store}>{children}</DisclosureContext.Provider>;
}

export function useSubagentDisclosure(
  key: string,
  fallback = false,
): [boolean, (value: boolean | ((current: boolean) => boolean)) => void] {
  const store = useContext(DisclosureContext);
  const [localOpen, setLocalOpen] = useState(fallback);
  const open = store.enabled ? (store.values.get(key) ?? fallback) : localOpen;
  const set = useCallback(
    (value: boolean | ((current: boolean) => boolean)) => {
      const next = typeof value === "function" ? value(open) : value;
      if (store.enabled) store.set(key, next);
      else setLocalOpen(next);
    },
    [store, key, open],
  );
  useEffect(() => {
    const reveal = (value: boolean) => {
      if (store.enabled) store.set(key, value);
      else setLocalOpen(value);
    };
    disclosureSetters.set(key, reveal);
    return () => {
      if (disclosureSetters.get(key) === reveal) disclosureSetters.delete(key);
    };
  }, [store, key]);
  return [open, set];
}
