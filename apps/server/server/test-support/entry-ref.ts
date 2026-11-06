/** Test seed: the file or folder at an address, as the mover takes it (by id). */
import type { ContextDestinationParent, ContextEntryRef } from "@meridian/contracts/protocol";
import {
  type ContextDeleteOptions,
  type ContextLocationChange,
  type ContextPort,
  contextAreaOf,
  deleteCommand,
  moveCommand,
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

type MoveToOptions = Omit<ContextLocationChange, "destination" | "operation" | "name"> & {
  expected: ContextEntryRef;
  /** Records the receipt, as the route's would. */
  operationId?: string;
  destinationParent?: ContextDestinationParent;
  /** The edit recheck on a destination folder named by identity; allows by default. */
  authorize?: (uri: string) => Promise<boolean>;
};

/**
 * A move to the address a writer typed: the folder is everything before the last slash, the
 * leaf what follows. `destinationParent` names the folder by identity, as the route does.
 */
export function moveTo(
  port: Pick<ContextPort, "commitWriterLocation">,
  from: string,
  to: string,
  options: MoveToOptions,
) {
  const { expected, operationId, destinationParent, authorize, ...rest } = options;
  const slash = to.lastIndexOf("/");
  const name = to.slice(slash + 1);
  const parent = destinationParent;
  const destination: ContextLocationChange["destination"] =
    parent?.kind === "folder"
      ? {
          kind: "folder",
          folderId: parent.folderId,
          createFolders: parent.createFolders,
          authorize: authorize ?? (async () => true),
        }
      : parent?.kind === "root"
        ? { kind: "at", folderUri: contextAreaOf(to), createFolders: parent.createFolders }
        : { kind: "at", folderUri: to.slice(0, slash + 1) };
  return port.commitWriterLocation(expected, contextAreaOf(from), {
    ...rest,
    destination,
    name,
    ...(operationId
      ? {
          operation: {
            id: operationId,
            command: moveCommand({ expected, destinationParent, position: rest.position, name }),
          },
        }
      : {}),
  });
}

/** A delete of the node at an address, with the receipt the route would record. */
export function deleteAt(
  port: Pick<ContextPort, "delete">,
  uri: string,
  options: Omit<ContextDeleteOptions, "operation"> & {
    expected: ContextEntryRef;
    operationId?: string;
  },
) {
  const { expected, operationId, ...rest } = options;
  return port.delete(expected, contextAreaOf(uri), {
    ...rest,
    ...(operationId
      ? { operation: { id: operationId, command: deleteCommand({ expected }) } }
      : {}),
  });
}
