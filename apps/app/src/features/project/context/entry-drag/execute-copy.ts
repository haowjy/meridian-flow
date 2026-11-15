/**
 * Copying planned rows. A Copy stays a server route (the server seeds each copy's text from its
 * source): the browser makes the copies' ids and the command's id, and the copies arrive through
 * the list like anyone's records. Each open document sends the state vector its tab holds, so the
 * server never copies less than this tab saw: it waits for typing still on its way, and while it
 * has not arrived the same Copy is sent again under the same id. An error is a typed answer to the
 * request, so it is the caller's to show.
 */
import type { Settlement } from "@meridian/contracts/commands";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type {
  ContextDestinationParent,
  CopyContextEntriesRequest,
} from "@meridian/contracts/protocol";
import { isMeridianApiError } from "@/client/api/meridian-error";
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

/** The server answers `source_behind` after a short wait; typing this tab holds reaches it within seconds. */
const SOURCE_BEHIND_RESEND_LIMIT_MS = 60_000;

const isSourceBehind = (error: unknown) =>
  isMeridianApiError(error) &&
  !!error.details &&
  typeof error.details === "object" &&
  "reason" in error.details &&
  error.details.reason === "source_behind";

/** What a Copy made, and what it settled instead (nothing made for a closed Work, a source left out). */
export type CopiedRows = { rows: readonly EntryRef[]; settled: readonly Settlement[] };

/**
 * Sends one Copy of the plan's rows. Returns the copies' identities and what the Copy left
 * undone; an error throws the route's error. `stateVectorOf` gives a document's open session's
 * vector, when this tab holds one.
 */
export async function copyRows(
  projectId: string,
  copy: ReadyCopy,
  stateVectorOf: (documentId: string) => Uint8Array | null,
): Promise<CopiedRows> {
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
      ...stateVectorField(row, stateVectorOf),
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
  const deadline = Date.now() + SOURCE_BEHIND_RESEND_LIMIT_MS;
  for (;;) {
    try {
      const { entries, settled } = await copyContextEntries(projectId, body);
      return {
        rows: entries
          .filter((entry) => copyIds.includes(entry.id))
          .map((entry) => ({ kind: entry.kind, id: entry.id })),
        settled: settled ?? [],
      };
    } catch (error) {
      if (!isSourceBehind(error) || Date.now() > deadline) throw error;
    }
  }
}

/** The live document's open session says what this tab holds of it; a folder or a draft view has no room here. */
function stateVectorField(
  row: ReadyCopy["copies"][number],
  stateVectorOf: (documentId: string) => Uint8Array | null,
): { stateVector?: string } {
  if (row.entry.kind !== "file" || row.view.kind !== "live") return {};
  const vector = stateVectorOf(row.entry.id);
  return vector ? { stateVector: btoa(String.fromCharCode(...vector)) } : {};
}
