/** One import owner for the authenticated account, independent of the current project. */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ImportToasts } from "./ImportToasts";
import { importApi } from "./import-api-port";
import { ImportCoordinator, type ImportsSnapshot } from "./import-coordinator";

const Context = createContext<ImportCoordinator | null>(null);
export function ImportsProvider({ children }: { children: ReactNode }) {
  const [coordinator] = useState(() => new ImportCoordinator(importApi));
  useEffect(() => coordinator.start(), [coordinator]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (coordinator.isWorking()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [coordinator]);
  return (
    <Context.Provider value={coordinator}>
      {children}
      <ImportToasts coordinator={coordinator} />
    </Context.Provider>
  );
}
export const useImportCoordinator = () => useContext(Context);
const EMPTY: ImportsSnapshot = { imports: [] };
const empty = () => EMPTY;
const noSubscribe = () => () => {};
export function useImportsSnapshot(coordinator: ImportCoordinator | null) {
  return useSyncExternalStore(
    coordinator?.subscribe ?? noSubscribe,
    coordinator?.getSnapshot ?? empty,
    coordinator?.getSnapshot ?? empty,
  );
}
