/**
 * The tree behind a Scratch listing: what `DrillInMenu` browses and the rail's Scratch section draws.
 *
 * One source serves the left rail's Scratch control and the dock document's
 * title chip, so both list the same notes the same way. Its catalog is the
 * owner's Scratch: a named Work's, or a No Work chat's lineage. A chat on a
 * Work whose lineage still holds notes lists them under one "Earlier notes"
 * folder at the top, so a rebind never hides them.
 */
import { t } from "@lingui/core/macro";
import {
  type ContextOwner,
  contextOwner,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { Folder } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import type { ServerContextTab } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import { fileKindIcon } from "./context-file-icon";
import { serverTabFromFile } from "./context-tab-from-file";

const EARLIER_ID = "earlier-notes";

export type CatalogMenuSource = {
  tree: DrillTree;
  /** The owner's own catalog (not the earlier notes), for rows and rename siblings. */
  catalog: CatalogContextView | null;
  /** The folders, outermost first, that hold the note at `path` in the owner's own Scratch. */
  foldersOf(path: string): DrillNode[];
  /** The tab a picked note opens as. */
  tabFor(rowId: string): ServerContextTab | null;
};

function sortNodes(nodes: DrillNode[]): DrillNode[] {
  return nodes.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
}

function listChildren(catalog: CatalogContextView, parentId: string | null): DrillNode[] {
  return sortNodes(
    catalog.children(parentId ?? catalog.root.entryId).map((node) => ({
      id: node.entryId,
      documentId: node.kind === "dir" ? undefined : node.documentId,
      name: node.name,
      folder: node.kind === "dir",
      icon: node.kind === "dir" ? Folder : fileKindIcon(node),
    })),
  );
}

export function useCatalogMenuSource({
  projectId,
  scheme = "scratch",
  owner,
  earlierRootThreadId,
  heading,
}: {
  projectId: string;
  /** The area browsed: the chat's Scratch by default, or whatever area the dock document is in. */
  scheme?: ProjectContextTreeScheme;
  /** Whose files the menu browses. */
  owner: ContextOwner;
  /** A lineage whose notes stay listed under "Earlier notes" while `owner` is a Work. */
  earlierRootThreadId?: string | null;
  heading: string;
}): CatalogMenuSource {
  const primary = useContextCatalogView(projectId, scheme, owner);
  const earlier = useContextCatalogView(projectId, "scratch", {
    ...contextOwner(null, earlierRootThreadId),
    enabled: Boolean(earlierRootThreadId),
  }).catalog;
  const catalog = primary.catalog;
  const earlierHasNotes = (earlier?.files().length ?? 0) > 0;

  const tree = useMemo<DrillTree>(
    () => ({
      heading,
      empty: t`No notes yet. The AI keeps its notes for this chat here.`,
      children: (folderId) => {
        if (folderId === EARLIER_ID) return earlier ? listChildren(earlier, null) : [];
        if (folderId === null) {
          const own = catalog ? listChildren(catalog, null) : [];
          return earlierHasNotes
            ? [{ id: EARLIER_ID, name: t`Earlier notes`, folder: true, icon: Folder }, ...own]
            : own;
        }
        if (catalog?.normalized.entries.has(folderId)) return listChildren(catalog, folderId);
        return earlier ? listChildren(earlier, folderId) : [];
      },
    }),
    [catalog, earlier, earlierHasNotes, heading],
  );

  const foldersOf = useCallback(
    (path: string): DrillNode[] => {
      if (!catalog) return [];
      const folders = path.split("/").filter(Boolean).slice(0, -1);
      return folders.flatMap((_, index) => {
        const folder = catalog.findPath(`/${folders.slice(0, index + 1).join("/")}`);
        return folder?.kind === "dir"
          ? [{ id: folder.entryId, name: folder.name, folder: true, icon: Folder }]
          : [];
      });
    },
    [catalog],
  );

  const tabFor = useCallback(
    (rowId: string): ServerContextTab | null => {
      const own = catalog?.files().find((file) => file.entryId === rowId);
      if (own) return serverTabFromFile(scheme, own, owner);
      const old = earlier?.files().find((file) => file.entryId === rowId);
      return old && earlierRootThreadId
        ? serverTabFromFile("scratch", old, { rootThreadId: earlierRootThreadId })
        : null;
    },
    [catalog, earlier, earlierRootThreadId, owner, scheme],
  );

  return {
    tree,
    catalog,
    foldersOf,
    tabFor,
  };
}
