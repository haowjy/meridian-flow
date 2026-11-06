/** One import owner for the authenticated account, independent of the current project. */
import { t } from "@lingui/core/macro";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { notifyFailure } from "@/components/app/failure-toast";
import { importApi } from "./import-api-port";
import { ImportCoordinator, type ImportsSnapshot, type TrackedImport } from "./import-coordinator";
import { importPresentation } from "./import-presentation";
import { useImportMilestone } from "./milestones";

const Context = createContext<ImportCoordinator | null>(null);
export function ImportsProvider({ children }: { children: ReactNode }) {
  const [coordinator] = useState(
    () =>
      new ImportCoordinator(importApi, (sentence) =>
        notifyFailure({
          key: `import-refused:${crypto.randomUUID()}`,
          title: t`Import didn't start. ${sentence}`,
        }),
      ),
  );
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
      <ImportWatches coordinator={coordinator} />
    </Context.Provider>
  );
}
/** What every import does wherever the writer is: says its milestones and reads its result. */
function ImportWatches({ coordinator }: { coordinator: ImportCoordinator }) {
  const { imports } = useImportsSnapshot(coordinator);
  return imports
    .filter((item) => !item.dismissed)
    .map((item) => <ImportWatch key={item.importId} item={item} coordinator={coordinator} />);
}
function ImportWatch({
  item: { importId, summary, local, detail },
  coordinator,
}: {
  item: TrackedImport;
  coordinator: ImportCoordinator;
}) {
  const { state, title } = importPresentation(summary, local);
  useImportMilestone(state, title);
  useEffect(() => {
    if (summary.state === "finished" && detail?.state !== "finished" && !local.error && !local.busy)
      void coordinator.loadDetail(importId);
  }, [summary.state, detail, coordinator, importId, local.error, local.busy]);
  return null;
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
