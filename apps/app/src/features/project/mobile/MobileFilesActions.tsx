/** The phone's `+` menu in the Files browser: New file, New folder and, where it applies, Import… (Folder…, Files…). */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { destinationOf, isImportScheme } from "@/features/import/destination";
import { ImportSheet } from "@/features/import/ImportPanel";
import {
  type PickKind,
  useImportPanel,
  useOptionalImports,
} from "@/features/import/ImportProvider";
import type { ContextCreateKind } from "../context/context-create-kind";
import { MobileCreateEntryMenu } from "./MobileCreateEntryMenu";

export function MobileFilesActions({
  projectId,
  editorWorkId,
  scheme,
  folder,
  onSelect,
}: {
  projectId: string;
  editorWorkId: string | null;
  scheme: ProjectContextTreeScheme;
  /** The folder being browsed ("/a/b"), or null at the area's root. */
  folder: string | null;
  onSelect: (kind: ContextCreateKind) => void;
}) {
  const imports = useOptionalImports();
  const { catalog } = useContextCatalogView(projectId, scheme, { workId: editorWorkId });
  const panel = useImportPanel("project");
  const importable = imports !== null && isImportScheme(scheme);
  const pick = (kind: PickKind) => {
    const node = folder ? catalog?.findPath(folder) : null;
    const destination = destinationOf(scheme, node?.kind === "dir" ? node : null);
    if (destination) imports?.pick(destination, kind);
  };
  return (
    <>
      <MobileCreateEntryMenu
        onSelect={onSelect}
        onImport={importable ? pick : undefined}
        importStatus={importable ? panel.status : null}
        onOpenImports={importable && panel.active ? () => panel.setOpen(true) : undefined}
      />
      {importable ? (
        <ImportSheet
          items={panel.items}
          open={panel.open}
          onOpenChange={panel.setOpen}
          onPick={pick}
        />
      ) : null}
    </>
  );
}
