/** Test seed: the file or folder at an address, as the mover takes it (by id). */
import type { ContextEntryRef } from "@meridian/contracts/protocol";
import type { ContextPort } from "../domains/context/index.js";

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
