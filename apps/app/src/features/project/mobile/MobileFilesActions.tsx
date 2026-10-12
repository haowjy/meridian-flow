/** The phone's `+` menu in the Files browser: New file, New folder and, where it applies, Import…. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { isImportScheme } from "@/features/import/destination";
import { useOptionalImports } from "@/features/import/ImportProvider";
import type { ContextCreateKind } from "../context/context-create-kind";
import { schemeLabel } from "../context/context-schemes";
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
          ? () => {
              const node = folder ? catalog?.findPath(folder) : catalog?.root;
              const dir = node?.kind === "dir" ? node : null;
              imports.openImport({
                scheme,
                path: dir && folder ? dir.path : "/",
                uri: dir && folder ? dir.uri : `${scheme}://`,
                name: dir && folder ? dir.name : schemeLabel(scheme),
                folderId: dir && folder ? dir.entryId : null,
              });
            }
          : undefined
      }
    />
  );
}
