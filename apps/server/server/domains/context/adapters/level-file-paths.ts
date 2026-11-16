import type { ContextDocument, ContextDocumentStore } from "../ports/context-document-store.js";
import { LIVE_TREE } from "../tree/tree-view.js";

type Occupant = { kind: "folder" } | { kind: "document"; document: ContextDocument };

export async function levelFilePaths(store: ContextDocumentStore) {
  const tree = await store.listTree(LIVE_TREE);
  const folders = new Map(tree.folders.map((folder) => [folder.id, folder]));
  const folderPaths = new Map<string, string>();
  const folderPath = (id: string | null): string => {
    if (id === null) return "";
    const known = folderPaths.get(id);
    if (known !== undefined) return known;
    const folder = folders.get(id);
    if (!folder) throw new Error(`Missing Agent folder ${id}`);
    const path = [folderPath(folder.parentId), folder.name].filter(Boolean).join("/");
    folderPaths.set(id, path);
    return path;
  };
  const occupants = new Map<string, Occupant[]>();
  const add = (dir: string, name: string, occupant: Occupant) => {
    const path = [dir, name].filter(Boolean).join("/");
    occupants.set(path, [...(occupants.get(path) ?? []), occupant]);
  };
  for (const folder of tree.folders)
    add(folderPath(folder.parentId), folder.name, { kind: "folder" });
  for (const document of tree.documents) {
    const name = document.extension ? `${document.name}.${document.extension}` : document.name;
    const occupant = { kind: "document" as const, document };
    const dir = folderPath(document.folderId);
    add(dir, name, occupant);
    if (!document.extension && document.fileType === null && document.filetype !== "source")
      add(dir, `${name}.md`, occupant);
  }
  return {
    classify(path: string) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const found = occupants.get(parts.slice(0, i).join("/"));
        if (found && (found.length !== 1 || found[0].kind !== "folder"))
          return { kind: "obstructed" as const };
      }
      const found = occupants.get(path);
      if (!found) return { kind: "absent" as const };
      if (found.length === 1 && found[0].kind === "document") {
        const document = found[0].document;
        if (document.fileType === null && document.filetype === "source")
          return { kind: "source" as const, document };
      }
      return { kind: "obstructed" as const };
    },
  };
}
