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

/** A move to the address a writer typed: the folder is everything before the last slash, the leaf what follows. */
export function moveTo(
  port: Pick<ContextPort, "commitWriterLocation">,
  from: string,
  to: string,
  options: Parameters<ContextPort["commitWriterLocation"]>[2],
) {
  const slash = to.lastIndexOf("/");
  return port.commitWriterLocation(from, to.slice(0, slash + 1), {
    ...options,
    name: to.slice(slash + 1),
  });
}
