/**
 * The project's import host: one coordinator, the hidden pickers, the unload
 * warning and the Continue dialog. Surfaces (tree rows and headers, the pane notice) reach it through `useImports()`; none of
 * them owns import state. Picking or dropping starts the import at once: there
 * is no confirm step.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { IMPORT_SCHEMES } from "@meridian/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { announce } from "@/client/stores/thread-store/announcements";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DroppedItems } from "@/lib/dropped-items";
import { ContinueImportDialog } from "./ContinueImportDialog";
import type { ImportDestination } from "./destination";
import { importApi } from "./import-api-port";
import {
  type CatalogReader,
  ImportCoordinator,
  type ImportsSnapshot,
  type SelectionRead,
} from "./import-coordinator";
import { readDropped } from "./read-dropped";
import { readPicked } from "./read-picked";
import { PickInputs } from "./SelectionPicker";
import type { Selection } from "./selection";
import { refusalOf } from "./selection-limits";

export type PickKind = "folder" | "files";

type DialogRequest =
  | { kind: "continue"; importId: string; key: number }
  | { kind: "refused"; message: string; key: number };

type ImportsApi = {
  coordinator: ImportCoordinator;
  /** Open the OS picker; choosing something starts the import into `destination`. */
  pick(destination: ImportDestination, kind: PickKind): void;
  /** Start importing what was dropped from outside into `destination`. */
  drop(destination: ImportDestination, items: DroppedItems): void;
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
  const catalog = useCatalogReader(projectId);
  const coordinator = useMemo(
    () => new ImportCoordinator(projectId, importApi, catalog),
    [projectId, catalog],
  );
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  // The OS picker answers later, through the input's change event.
  const picking = useRef<{ destination: ImportDestination; kind: PickKind } | null>(null);

  useEffect(() => {
    return coordinator.watchOpen();
  }, [coordinator]);

  // Closing the page stops reading and uploads; the browser's own wording warns first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!coordinator.isWorking()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [coordinator]);

  /** The run's read: refuse what cannot start (null, with the reason said here), else announce it. */
  const guarded = useCallback(
    (
      destination: ImportDestination,
      source: PickKind | "drop",
      read: (options: Parameters<SelectionRead>[0]) => Promise<Selection>,
    ): SelectionRead =>
      async (options) => {
        const selection = await read(options);
        const refusal = refusalOf(selection, source);
        if (refusal) {
          setRequest({ kind: "refused", message: refusal, key: Date.now() });
          return null;
        }
        const files = selection.roots.reduce((sum, root) => sum + root.files.length, 0);
        const into = destination.name;
        announce(
          plural(files, {
            one: `Importing # file into ${into}.`,
            other: `Importing # files into ${into}.`,
          }),
        );
        return selection;
      },
    [],
  );

  const api = useMemo<ImportsApi>(
    () => ({
      coordinator,
      pick: (destination, kind) => {
        picking.current = { destination, kind };
        (kind === "folder" ? folderInput : filesInput).current?.click();
      },
      drop: (destination, items) => {
        coordinator.begin(
          destination,
          guarded(destination, "drop", (options) => readDropped(items, options)),
        );
      },
      openContinue: (importId) => setRequest({ kind: "continue", importId, key: Date.now() }),
    }),
    [coordinator, guarded],
  );

  const picked = useCallback(
    (files: File[]) => {
      const choice = picking.current;
      picking.current = null;
      if (!choice) return;
      coordinator.begin(
        choice.destination,
        guarded(choice.destination, choice.kind, () => readPicked(files)),
      );
    },
    [coordinator, guarded],
  );

  return (
    <ImportsContext.Provider value={api}>
      {children}
      <PickInputs folderRef={folderInput} filesRef={filesInput} onPick={picked} />
      {request?.kind === "continue" ? (
        <ContinueImportDialog
          key={request.key}
          importId={request.importId}
          coordinator={coordinator}
          onClose={() => setRequest(null)}
        />
      ) : null}
      {request?.kind === "refused" ? (
        <RefusedDialog message={request.message} onClose={() => setRequest(null)} />
      ) : null}
    </ImportsContext.Provider>
  );
}

/** A pick or drop that cannot start has no row to carry the reason, so say it here. */
function RefusedDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Nothing to import</Trans>
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button className="[@media(pointer:coarse)]:min-h-11">{t`Close`}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the project's catalogs hold, for the coordinator: whether a node id is in
 * any import area now, and a notification when the views change. The reader is
 * stable for the project; the views it reads move.
 */
function useCatalogReader(projectId: string): CatalogReader {
  const views = useContextCatalogViews(projectId, IMPORT_SCHEMES, {});
  const latest = useRef(views);
  const listeners = useRef(new Set<() => void>());
  const reader = useMemo<CatalogReader>(
    () => ({
      holds: (id) =>
        IMPORT_SCHEMES.some((scheme) => {
          const catalog = latest.current[scheme]?.catalog;
          return (
            catalog != null &&
            (catalog.findDocument(id) !== null ||
              catalog.normalized.entries.get(id)?.kind === "folder")
          );
        }),
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );
  useEffect(() => {
    latest.current = views;
    for (const listener of [...listeners.current]) listener();
  }, [views]);
  return reader;
}

/** The imports to show rows for, newest first, with their current state. */
export function useImportsSnapshot(coordinator: ImportCoordinator | null): ImportsSnapshot {
  return useSyncExternalStore(
    coordinator?.subscribe ?? noSubscribe,
    coordinator?.getSnapshot ?? emptySnapshot,
    coordinator?.getSnapshot ?? emptySnapshot,
  );
}

const EMPTY: ImportsSnapshot = { imports: [], documents: new Map() };
const emptySnapshot = () => EMPTY;
const noSubscribe = () => () => {};
