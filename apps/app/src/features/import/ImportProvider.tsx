/**
 * The project's import host: one coordinator, the dialog, the unload warning and
 * the open-imports list. Surfaces (tree headers, status rows, the report) reach
 * it through `useImports()`; none of them owns import state.
 */
import { t } from "@lingui/core/macro";
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
import { announce } from "@/client/stores/thread-store/announcements";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { ContinueImportDialog } from "./ContinueImportDialog";
import type { ImportDestination } from "./destination";
import { ImportDialog } from "./ImportDialog";
import { ImportCoordinator, type ImportsSnapshot } from "./import-coordinator";
import { useImportRoute } from "./import-route";
import type { DroppedItems } from "./read-dropped";
import type { Selection } from "./selection";

type DialogRequest =
  | { kind: "import"; destination: ImportDestination; dropped?: DroppedItems; key: number }
  | { kind: "continue"; importId: string; key: number };

type ImportsApi = {
  coordinator: ImportCoordinator;
  openImport(destination: ImportDestination, dropped?: DroppedItems): void;
  openContinue(importId: string): void;
};

const ImportsContext = createContext<ImportsApi | null>(null);

export function useImports(): ImportsApi {
  const value = useContext(ImportsContext);
  if (!value) throw new Error("useImports needs an ImportProvider");
  return value;
}

/** For callers that render outside a project (tests, headers before mount). */
export function useOptionalImports(): ImportsApi | null {
  return useContext(ImportsContext);
}

export function ImportProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const coordinator = useMemo(() => new ImportCoordinator(projectId), [projectId]);
  const route = useImportRoute();
  const phone = usePhoneShell();
  const [request, setRequest] = useState<DialogRequest | null>(null);

  useEffect(() => {
    const stop = coordinator.watchOpen();
    return () => {
      stop();
      coordinator.dispose();
    };
  }, [coordinator]);

  // Closing the page stops uploads; the browser's own wording warns first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!coordinator.isPreparingOrUploading()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [coordinator]);

  const api = useMemo<ImportsApi>(
    () => ({
      coordinator,
      openImport: (destination, dropped) =>
        setRequest({ kind: "import", destination, dropped, key: Date.now() }),
      openContinue: (importId) => setRequest({ kind: "continue", importId, key: Date.now() }),
    }),
    [coordinator],
  );

  const begin = useCallback(
    (selection: Selection, destination: ImportDestination) => {
      setRequest(null);
      const importId = coordinator.start(selection, destination);
      coordinator.notifyStarted();
      const files = selection.roots.reduce((sum, root) => sum + root.files.length, 0);
      announce(t`Importing ${files} files into ${destination.name}.`);
      // The phone shows the destination folder, its status row first; the desktop
      // opens the report beside the arriving rows.
      if (phone)
        route.showFolder(destination.scheme, destination.path === "/" ? "" : destination.path);
      else route.openReport(importId);
    },
    [coordinator, route, phone],
  );

  return (
    <ImportsContext.Provider value={api}>
      {children}
      {request?.kind === "import" ? (
        <ImportDialog
          key={request.key}
          destination={request.destination}
          dropped={request.dropped}
          onImport={(selection) => begin(selection, request.destination)}
          onClose={() => setRequest(null)}
        />
      ) : null}
      {request?.kind === "continue" ? (
        <ContinueImportDialog
          key={request.key}
          importId={request.importId}
          coordinator={coordinator}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </ImportsContext.Provider>
  );
}

/** The imports to show rows for, newest first, with their current state. */
export function useImportsSnapshot(coordinator: ImportCoordinator | null): ImportsSnapshot {
  return useSyncExternalStore(
    coordinator?.subscribe ?? noSubscribe,
    coordinator?.getSnapshot ?? emptySnapshot,
    coordinator?.getSnapshot ?? emptySnapshot,
  );
}

const EMPTY: ImportsSnapshot = { ids: [], states: [] };
const emptySnapshot = () => EMPTY;
const noSubscribe = () => () => {};
