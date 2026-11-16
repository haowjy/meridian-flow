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
  CopyContextEntriesResult,
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

/** A source's owner as the route takes it: only a Work's own areas (Scratch) name a Work. */
function ownerFields(area: Pick<MoveArea, "owner" | "scheme">) {
  const { owner } = area;
  const scoped = isWorkScopedScheme(area.scheme);
  return {
    workId: scoped ? (owner.workId ?? null) : null,
    rootThreadId: scoped ? (owner.rootThreadId ?? null) : null,
    ...(owner.chatThreadId ? { chatRef: owner.chatRef ?? null } : {}),
  };
}

/**
 * Sends one Copy of the plan's rows. The copies' identities are the browser's, so they come back
 * at once, before the server answers; `answered` resolves with the route's answer, or rejects with its error on a refusal.
 */
export function copyRows(
  projectId: string,
  copy: ReadyCopy,
): { copies: readonly EntryRef[]; answered: Promise<CopyContextEntriesResult> } {
  const minted = copy.copies.map((row) => ({ row, copyId: crypto.randomUUID() }));
  const destination = destinationOf(copy);
  const folder = copy.into === copy.area.tree.root.entryId ? null : copy.area.tree.entry(copy.into);
  const body: CopyContextEntriesRequest = {
    operationId: crypto.randomUUID(),
    sources: minted.map(({ row, copyId }) => ({
      scheme: row.place.scheme,
      path: withoutLeadingSlash(row.place.path),
      expected: { kind: row.entry.kind, nodeId: row.entry.id },
      ...ownerFields(row.place),
      view: row.view,
      copyId,
    })),
    destinationScheme: copy.scheme,
    destinationFolderPath: folder ? withoutLeadingSlash(folder.path) : "",
    destinationWorkId: isWorkScopedScheme(copy.scheme) ? (copy.area.owner.workId ?? null) : null,
    destinationRootThreadId: isWorkScopedScheme(copy.scheme)
      ? (copy.area.owner.rootThreadId ?? null)
      : null,
    destinationParent: destination,
    ...(copy.area.view?.kind === "draft" ? { destinationView: copy.area.view } : {}),
    ...(copy.position ? { position: copy.position } : {}),
  };
  return {
    copies: minted.map(({ row, copyId }) => ({ kind: row.entry.kind, id: copyId })),
    answered: copyContextEntries(projectId, body),
  };
}
