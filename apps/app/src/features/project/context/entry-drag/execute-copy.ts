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
 * The server answers `source_behind` (a 503) after a short wait; typing this tab holds reaches
 * it, so the Copy is sent again, slower each time, for as long as it takes. Temporary: Copy moves
 * onto the command driver, which owns this wait.
 */
const RESEND_FIRST_MS = 500;
const RESEND_LAST_MS = 5_000;

const isSourceBehind = (error: unknown) =>
  isMeridianApiError(error) &&
  !!error.details &&
  typeof error.details === "object" &&
  "reason" in error.details &&
  error.details.reason === "source_behind";

/** A document's open session's vector, in the live room or the draft room, when this tab holds one. */
export type StateVectorOf = (documentId: string, view: "live" | "draft") => Uint8Array | null;

/**
 * Sends one Copy of the plan's rows. The copies' identities are the browser's, so they come back
 * at once, before the server answers; `answered` resolves with what the Copy left undone (nothing
 * made for a closed Work, a source left out) and rejects with the route's error on a refusal.
 * `stateVectorOf` gives a document's open session's vector, when this tab holds one.
 */
export function copyRows(
  projectId: string,
  copy: ReadyCopy,
  stateVectorOf: StateVectorOf,
): { copies: readonly EntryRef[]; answered: Promise<readonly Settlement[]> } {
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
      ...stateVectorField(row, stateVectorOf),
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
  const send = async (): Promise<readonly Settlement[]> => {
    for (let wait = RESEND_FIRST_MS; ; wait = Math.min(wait * 2, RESEND_LAST_MS)) {
      try {
        return (await copyContextEntries(projectId, body)).settled ?? [];
      } catch (error) {
        if (!isSourceBehind(error)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };
  return {
    copies: minted.map(({ row, copyId }) => ({ kind: row.entry.kind, id: copyId })),
    answered: send(),
  };
}

/** The open session of the view's room says what this tab holds of the document; a folder has no room. */
function stateVectorField(
  row: ReadyCopy["copies"][number],
  stateVectorOf: StateVectorOf,
): { stateVector?: string } {
  if (row.entry.kind !== "file") return {};
  const vector = stateVectorOf(row.entry.id, row.view.kind);
  return vector ? { stateVector: btoa(String.fromCharCode(...vector)) } : {};
}
