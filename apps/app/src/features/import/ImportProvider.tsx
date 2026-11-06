/** Project-scoped picker and drop doors. Upload ownership lives above project navigation. */
import { t } from "@lingui/core/macro";
import type { ImportScheme } from "@meridian/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DroppedItems } from "@/lib/dropped-items";
import type { ImportDestination } from "./destination";
import { useImportCoordinator, useImportsSnapshot } from "./ImportsProvider";
import type { SelectionRead, TrackedImport } from "./import-coordinator";
import {
  type ImportStatus,
  importScheme,
  importState,
  importStatus,
  READ_ON_CLOSE,
} from "./import-presentation";
import { readDropped } from "./read-dropped";
import { readPicked } from "./read-picked";
import { PickInputs } from "./SelectionPicker";
import { refusalOf } from "./selection-limits";

export { useImportsSnapshot };
export type PickKind = "folder" | "files";
type Doors = {
  pick(destination: ImportDestination, kind: PickKind): void;
  drop(destination: ImportDestination, items: DroppedItems): void;
  coordinator: NonNullable<ReturnType<typeof useImportCoordinator>>;
  projectId: string;
};
/** What one entry point stands for: an area's section header, or the phone's whole-project menu. */
export type ImportPanelScope = ImportScheme | "project";
type Panel = {
  scope: ImportPanelScope | null;
  setScope: (scope: ImportPanelScope | null) => void;
  reveal: (importId: string) => void;
};
const Context = createContext<Doors | null>(null);
const PanelContext = createContext<Panel | null>(null);
export const useOptionalImports = () => useContext(Context);
const inScope = ({ summary }: TrackedImport, scope: ImportPanelScope) =>
  scope === "project" || importScheme(summary) === scope;

/** The imports an entry point stands for, what its button shows, and its popup. */
export function useImportPanel(scope: ImportPanelScope) {
  const doors = useOptionalImports();
  const panel = useContext(PanelContext);
  const { imports } = useImportsSnapshot(doors?.coordinator ?? null);
  const projectId = doors?.projectId;
  const items = useMemo(
    () =>
      imports.filter(
        (item) => !item.dismissed && item.summary.projectId === projectId && inScope(item, scope),
      ),
    [imports, projectId, scope],
  );
  const statuses = items.map(importStatus);
  const status: ImportStatus | null = statuses.includes("needs-writer")
    ? "needs-writer"
    : statuses.includes("running")
      ? "running"
      : null;
  const open = panel?.scope === scope;
  const setScope = panel?.setScope;
  const setOpen = useCallback(
    (next: boolean) => setScope?.(next ? scope : null),
    [setScope, scope],
  );
  // An open popup keeps a clean result on screen after the button has gone back to normal.
  return { items, status, open, setOpen, active: open || status !== null };
}
/** Opens the popup that carries an import; for a pending tree row. */
export const useRevealImport = () => useContext(PanelContext)?.reveal;
export function ImportProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const coordinator = useImportCoordinator()!;
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const choice = useRef<{ destination: ImportDestination; kind: PickKind } | null>(null);
  const begin = (
    destination: ImportDestination,
    label: string,
    kind: PickKind | "drop",
    read: SelectionRead,
    rootName?: string,
  ) =>
    coordinator.begin(
      projectId,
      destination,
      label,
      async (options) => {
        const selection = await read(options);
        const refusal = refusalOf(selection, kind);
        if (refusal) throw new Error(refusal);
        return selection;
      },
      rootName,
    );
  const { imports } = useImportsSnapshot(coordinator);
  const own = useMemo(
    () => imports.filter((item) => !item.dismissed && item.summary.projectId === projectId),
    [imports, projectId],
  );
  const [scope, setScope] = useState<ImportPanelScope | null>(null);
  const shown = (item: TrackedImport) => scope !== null && inScope(item, scope);
  // A clean result needs no reading: it goes at once, unless an open popup is showing it.
  useEffect(() => {
    for (const item of own)
      if (importStatus(item) === null && !item.local.busy && !shown(item))
        void coordinator.acknowledge(item.importId);
  }, [own, scope, coordinator]);
  const latest = useRef({ own, shown });
  latest.current = { own, shown };
  const panel = useMemo<Panel>(
    () => ({
      scope,
      setScope(next) {
        if (next === null)
          for (const item of latest.current.own)
            if (
              latest.current.shown(item) &&
              importStatus(item) !== null &&
              !item.local.busy &&
              READ_ON_CLOSE.has(importState(item.summary, item.local))
            )
              void coordinator.acknowledge(item.importId);
        setScope(next);
      },
      reveal(importId) {
        const item = latest.current.own.find((candidate) => candidate.importId === importId);
        if (item) setScope(importScheme(item.summary));
      },
    }),
    [scope, coordinator],
  );
  const doors = useMemo<Doors>(
    () => ({
      coordinator,
      projectId,
      pick(destination, kind) {
        choice.current = { destination, kind };
        (kind === "folder" ? folder : files).current?.click();
      },
      drop(destination, items) {
        const single =
          items.entries.length === 1 && items.entries[0]?.isDirectory
            ? items.entries[0].name
            : undefined;
        begin(
          destination,
          single ?? t`your files`,
          "drop",
          (options) => readDropped(items, options),
          single,
        );
      },
    }),
    [coordinator, projectId],
  );
  return (
    <Context.Provider value={doors}>
      <PanelContext.Provider value={panel}>{children}</PanelContext.Provider>
      <PickInputs
        folderRef={folder}
        filesRef={files}
        onPick={(picked) => {
          const request = choice.current;
          choice.current = null;
          if (request)
            begin(
              request.destination,
              request.kind === "folder"
                ? (picked[0]?.webkitRelativePath.split("/")[0] ?? t`your files`)
                : t`your files`,
              request.kind,
              () => readPicked(picked),
              request.kind === "folder" &&
                !picked.some(
                  (file) =>
                    file.webkitRelativePath.split("/").length === 2 &&
                    file.name === "meridian-export.json",
                )
                ? picked[0]?.webkitRelativePath.split("/")[0]
                : undefined,
            );
        }}
      />
    </Context.Provider>
  );
}
