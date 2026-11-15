import { firstFreeName } from "@meridian/contracts/protocol";
import type { ContextDocument, ContextDocumentStore } from "../ports/context-document-store.js";
import { LIVE_TREE } from "../tree/tree-view.js";

type Occupant =
  | { kind: "reserved" }
  | { kind: "folder" }
  | { kind: "document"; document: ContextDocument };

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
  const names = new Map<string, Set<string>>();
  const add = (dir: string, name: string, occupant: Occupant) => {
    const path = [dir, name].filter(Boolean).join("/");
    occupants.set(path, [...(occupants.get(path) ?? []), occupant]);
    const taken = names.get(dir) ?? new Set<string>();
    taken.add(name);
    names.set(dir, taken);
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
    allocate(path: string) {
      const parts = path.split("/");
      let dir = "";
      for (const [index, part] of parts.entries()) {
        const leaf = index === parts.length - 1;
        const at = [dir, part].filter(Boolean).join("/");
        const found = occupants.get(at);
        const taken = names.get(dir) ?? new Set<string>();
        const dot = leaf ? part.lastIndexOf(".") : -1;
        const filename =
          found && (leaf || found.length !== 1 || found[0].kind !== "folder")
            ? firstFreeName(
                {
                  name: dot > 0 ? part.slice(0, dot) : part,
                  extension: dot > 0 ? part.slice(dot + 1) : "",
                },
                taken,
              ).filename
            : part;
        // Reserve the batch's parents and filenames too, before planning the next file.
        if (leaf || !occupants.has([dir, filename].filter(Boolean).join("/")))
          add(dir, filename, { kind: leaf ? "reserved" : "folder" });
        dir = [dir, filename].filter(Boolean).join("/");
      }
      return dir;
    },
  };
}
