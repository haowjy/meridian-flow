/** Project-scoped picker and drop doors. Upload ownership lives above project navigation. */
import { t } from "@lingui/core/macro";
import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import type { DroppedItems } from "@/lib/dropped-items";
import type { ImportDestination } from "./destination";
import { useImportCoordinator } from "./ImportsProvider";
import type { SelectionRead } from "./import-coordinator";
import { readDropped } from "./read-dropped";
import { readPicked } from "./read-picked";
import { PickInputs } from "./SelectionPicker";
import { refusalOf } from "./selection-limits";

export { useImportsSnapshot } from "./ImportsProvider";
export type PickKind = "folder" | "files";
type Doors = {
  pick(destination: ImportDestination, kind: PickKind): void;
  drop(destination: ImportDestination, items: DroppedItems): void;
  coordinator: NonNullable<ReturnType<typeof useImportCoordinator>>;
};
const Context = createContext<Doors | null>(null);
export const useOptionalImports = () => useContext(Context);
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
  const doors = useMemo<Doors>(
    () => ({
      coordinator,
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
      {children}
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
