/** Lists metadata only. Bytes are read once, by the upload, never hashed in the browser. */
import type { ImportSelection } from "@meridian/contracts";
import type { Selection } from "./selection";

export type HeldFile = {
  entryId: number;
  rootId: number;
  path: string;
  file: File;
  changed?: boolean;
};
export function buildSelection(selection: Selection, importId: string, destinationUri: string) {
  const command: ImportSelection = {
    importId,
    destination: { folderUri: destinationUri },
    roots: [],
    folders: [],
    entries: [],
    unreadable: [],
  };
  const held = new Map<number, HeldFile>();
  for (const { files, folders, unreadable, ...root } of selection.roots) {
    command.roots.push(root);
    command.folders.push(...folders.map((path) => ({ rootId: root.rootId, path })));
    command.unreadable?.push(...unreadable.map((item) => ({ rootId: root.rootId, ...item })));
    for (const { path, file } of files) {
      const entryId = command.entries.length;
      command.entries.push({
        entryId,
        rootId: root.rootId,
        path,
        size: file.size,
        modifiedAt: file.lastModified,
      });
      held.set(entryId, { entryId, rootId: root.rootId, path, file });
    }
  }
  return { command, held };
}
