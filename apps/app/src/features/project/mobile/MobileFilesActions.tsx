/** The phone's `+` menu in the Files browser: New file, New folder and, where it applies, Import… (Folder…, Files…). */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { destinationOf, isImportScheme } from "@/features/import/destination";
import { useOptionalImports } from "@/features/import/ImportProvider";
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
  const importable = imports !== null && isImportScheme(scheme);
  return (
    <MobileCreateEntryMenu
      onSelect={onSelect}
      onImport={
        importable
          ? (kind) => {
              const node = folder ? catalog?.findPath(folder) : null;
              const destination = destinationOf(scheme, node?.kind === "dir" ? node : null);
              if (destination) imports.pick(destination, kind);
            }
          : undefined
      }
    />
  );
}
