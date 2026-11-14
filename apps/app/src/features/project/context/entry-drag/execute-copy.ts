/**
 * Copying planned rows. A Copy stays a server route (the server seeds each copy's text from its
 * source): the browser makes the copies' ids and the command's id, sends them once, and the copies
 * arrive through the list like anyone's records. A refusal is a typed answer to the request, so
 * it is the caller's to show; nothing is kept to send again.
 */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type {
  ContextDestinationParent,
  CopyContextEntriesRequest,
} from "@meridian/contracts/protocol";
import { copyContextEntries } from "@/client/api/projects-api";
import type { EntryRef } from "./entry";
import type { MoveArea, ReadyCopy } from "./move-plan";

const withoutLeadingSlash = (path: string) => path.replace(/^\/+/, "");

/** The destination as the route names it: a folder by id, or the top of a tree with its owner. */
function destinationOf(copy: ReadyCopy): ContextDestinationParent {
  const { area, into, scheme } = copy;
  if (into !== area.tree.root.entryId) return { kind: "folder", folderId: into };
  return {
    kind: "root",
    scheme,
    owner: isWorkScopedScheme(scheme)
      ? { workId: area.owner.workId ?? null, rootThreadId: area.owner.rootThreadId ?? null }
      : { workId: null },
  };
}

function ownerFields(area: Pick<MoveArea, "owner">) {
  const { owner } = area;
  return {
    workId: owner.workId ?? null,
    rootThreadId: owner.rootThreadId ?? null,
    ...(owner.chatThreadId ? { chatRef: owner.chatRef ?? null } : {}),
  };
}

/**
 * Sends one Copy of the plan's rows. Returns the copies' identities; a refusal throws the route's
 * error.
 */
export async function copyRows(projectId: string, copy: ReadyCopy): Promise<readonly EntryRef[]> {
  const copyIds: string[] = copy.copies.map(() => crypto.randomUUID());
  const destination = destinationOf(copy);
  const folder = copy.into === copy.area.tree.root.entryId ? null : copy.area.tree.entry(copy.into);
  const body: CopyContextEntriesRequest = {
    operationId: crypto.randomUUID(),
    sources: copy.copies.map((row, index) => ({
      scheme: row.place.scheme,
      path: withoutLeadingSlash(row.place.path),
      expected: { kind: row.entry.kind, nodeId: row.entry.id },
      ...ownerFields({ owner: row.place.owner }),
      view: row.view,
      copyId: copyIds[index],
    })),
    destinationScheme: copy.scheme,
    destinationFolderPath: folder ? withoutLeadingSlash(folder.path) : "",
    destinationWorkId: isWorkScopedScheme(copy.scheme) ? (copy.area.owner.workId ?? null) : null,
    destinationRootThreadId: isWorkScopedScheme(copy.scheme)
      ? (copy.area.owner.rootThreadId ?? null)
      : null,
    destinationParent: destination,
    ...(copy.position ? { position: copy.position } : {}),
  };
  const { entries } = await copyContextEntries(projectId, body);
  return entries
    .filter((entry) => copyIds.includes(entry.id))
    .map((entry) => ({ kind: entry.kind, id: entry.id }));
}
