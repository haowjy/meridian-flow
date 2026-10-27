/**
 * Copying planned rows through the replica's one Copy path, and taking a Copy back. A Copy is
 * optimistic like a Move: it resolves once the replica admits the operation, the copies are listed
 * under predicted names at once, and the server's answer places them or refuses the whole Copy.
 * Results are data; wording, selection and the notice belong to the caller.
 */
import type { EntryRef } from "./entry";
import { arrivals, currentView, type ReplicaContext } from "./execute-move";
import { outermostEntries, type ReadyCopy } from "./move-plan";

/** One copy as the replica listed it: the copy's identity, and the row it came from. */
export type CopyEffect = {
  /** The copy: a document by its ID, or a folder by its entry ID. */
  entry: EntryRef;
  /** The record that holds it before the server answers, which Undo deletes through. */
  handle: string;
  /** The name it is listed under. */
  name: string;
  sourceName: string;
};

export type CopyResult = {
  operationId: string;
  copies: readonly CopyEffect[];
  destinationName: string;
};

/** The rows a Copy would add to its destination, for naming them. */
export const copyArrivals = (copy: ReadyCopy) =>
  copy.copies.map((row) => ({ ...row, after: copy.into }));

/**
 * Admits one Copy of the plan's rows, each under its predicted free name (two copies of `Notes`
 * become `Notes (2)` and `Notes (3)`). A document the device holds open sends its pending edits
 * with the Copy. `origin` names the surface that started it, for a refusal whose destination is
 * gone. Null when the replica would not admit the Copy.
 */
export async function copyRows(
  copy: ReadyCopy,
  context: ReplicaContext,
  origin: string,
): Promise<CopyResult | null> {
  const rows = copyArrivals(copy);
  const names = arrivals(await currentView(context), rows);
  const sources = rows.map((row) => {
    const predictedName = names.name(row);
    names.reserve(row, predictedName);
    return { kind: row.entry.kind, id: row.entry.id, predictedName, sourceName: row.name };
  });
  try {
    const { operationId, roots } = await context.resources.copyEntries(context.projectId, {
      sources: sources.map(({ sourceName: _, ...source }) => source),
      scheme: copy.scheme,
      destination: { parent: copy.into, ...(copy.position ? { position: copy.position } : {}) },
      origin,
    });
    return {
      operationId,
      destinationName: copy.destinationName,
      copies: roots.map((root) => ({
        entry: { kind: root.kind, id: root.copyId },
        handle: root.handle,
        name: root.predictedName,
        sourceName: sources.find((source) => source.id === root.sourceId)?.sourceName ?? "",
      })),
    };
  } catch {
    return null;
  }
}

/** One delete Undo admitted, or the copy whose delete the replica would not admit. */
export type CopyUndoResult = {
  deleted: readonly { entry: EntryRef; name: string; operationId?: string }[];
  failed: readonly { entry: EntryRef; name: string }[];
};

/**
 * Takes a Copy back as ordinary deletes: every copy it made that is still listed, except the ones
 * inside another of them, which go with it. `entries` are the copies' identities (the roots before
 * the server answers; the receipt's every created identity after, so a copy moved out of its
 * folder is still found). Edits and additions made since go with the copy. Before the answer the
 * deletes queue behind the Copy.
 */
export async function undoCopy(
  entries: readonly EntryRef[],
  context: ReplicaContext,
): Promise<CopyUndoResult> {
  const { resources, projectId } = context;
  const deleted: CopyUndoResult["deleted"][number][] = [];
  const failed: CopyUndoResult["failed"][number][] = [];
  for (const { ref, name } of outermostEntries(await currentView(context), entries)) {
    try {
      const key = ref.kind === "file" ? await resources.keyForDocument(projectId, ref.id) : null;
      if (ref.kind === "file" && !key) throw new Error("Document is not in the replica");
      const result =
        ref.kind === "file" && key
          ? await resources.deleteDocument(projectId, key)
          : await resources.deleteFolder(projectId, ref.id);
      deleted.push({
        entry: ref,
        name,
        ...(result.operationId ? { operationId: result.operationId } : {}),
      });
    } catch {
      failed.push({ entry: ref, name });
    }
  }
  return { deleted, failed };
}
