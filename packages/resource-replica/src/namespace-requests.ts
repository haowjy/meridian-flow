/**
 * The move and delete requests both namespace journals send: the entry by id, and only what the
 * writer chose. A request that carried the entry's path, name and parent as this device last saw
 * them would undo another device's rename or move the moment it landed; leaving them out keeps
 * whatever the row is now.
 */
import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { NamespaceRequest, ParentRef, ResourceDestination } from "./resource-records";

type Entry = Readonly<{ kind: "file" | "folder"; id: string }>;

export function deleteRequest(
  entry: Entry,
  operationId: string,
): Extract<NamespaceRequest, { kind: "delete" }> {
  return {
    kind: "delete",
    entryId: entry.id,
    body: { operationId, expected: { kind: entry.kind } },
  };
}

/**
 * `current` is the entry's place as this device last observed it: the destination's name and
 * parent are sent only where they differ from it. A position alone reorders in the row's parent.
 */
export function moveRequest(
  entry: Entry,
  operationId: string,
  intent: { destination: ResourceDestination; typedName: string },
  current: { name: string; parent?: ParentRef },
): Extract<NamespaceRequest, { kind: "move" }> {
  const { destination } = intent;
  const sameParent =
    !destination.createFolders?.length &&
    current.parent !== undefined &&
    JSON.stringify(current.parent) === JSON.stringify(destination.parent);
  const position: ContextSiblingPosition | undefined = destination.position;
  return {
    kind: "move",
    entryId: entry.id,
    body: {
      operationId,
      expected: { kind: entry.kind },
      ...(sameParent
        ? {}
        : {
            destinationParent: {
              ...destination.parent,
              ...(destination.createFolders?.length
                ? { createFolders: destination.createFolders }
                : {}),
            },
          }),
      // The typed spelling can differ from the stored one ("Chapter 13.md" for "Chapter 13"):
      // naming a file what it is already called asks for no rename.
      ...(intent.typedName !== current.name && destination.name !== current.name
        ? { name: intent.typedName }
        : {}),
      ...(position ? { position } : {}),
    },
  };
}
