/** Test seed: the file or folder at an address, as the mover takes it (by id). */
import type { ContextEntryRef } from "@meridian/contracts/protocol";
import {
  type ContextDeleteOptions,
  type ContextLocationChange,
  type ContextPort,
  contextAreaOf,
} from "../domains/context/index.js";

export async function entryAt(
  port: Pick<ContextPort, "stat" | "list">,
  uri: string,
): Promise<ContextEntryRef> {
  const file = await port.stat(uri);
  if (file.ok && file.value.documentId) return { kind: "file", nodeId: file.value.documentId };
  const trimmed = uri.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const listed = await port.list(trimmed.slice(0, trimmed.length - name.length));
  const folder = listed.ok
    ? listed.value.entries.find(
        (entry) => entry.kind === "directory" && entry.uri.replace(/\/+$/, "") === trimmed,
      )
    : undefined;
  if (!folder?.folderId) throw new Error(`Nothing to move at ${uri}`);
  return { kind: "folder", nodeId: folder.folderId };
}

type MoveToOptions = Omit<ContextLocationChange, "destination" | "name"> & {
  expected: ContextEntryRef;
};

/** A move to the address a writer typed: the folder is everything before the last slash, the leaf what follows. */
export function moveTo(
  port: Pick<ContextPort, "move">,
  from: string,
  to: string,
  options: MoveToOptions,
) {
  const { expected, ...rest } = options;
  const slash = to.lastIndexOf("/");
  return port.move(expected, contextAreaOf(from), {
    ...rest,
    destination: { kind: "at", folderUri: to.slice(0, slash + 1) },
    name: to.slice(slash + 1),
  });
}

export function deleteAt(
  port: Pick<ContextPort, "delete">,
  uri: string,
  options: ContextDeleteOptions & { expected: ContextEntryRef },
) {
  const { expected, ...rest } = options;
  return port.delete(expected, contextAreaOf(uri), rest);
}
