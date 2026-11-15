import type { ClosedOwnerWhy, Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { closedOwnerOf, ownerNames } from "../../../shared/draft-owner.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { LockedWorkWriteSet } from "../../projects/index.js";

/**
 * A tree effect changed a source whose owner the command did not lock: what live had changed
 * between the read the locks were chosen from and the list's key. The command runs again, from
 * its transaction's start, with that source's owner in the set.
 */
export class TreeOwnersMoved extends Error {
  constructor(readonly source: string) {
    super(`a tree effect changed source ${source}, whose owner was not locked`);
  }
}

/** Whose notes a source is: a Work's or a chat lineage's; neither for a project's or an account's. */
type SourceOwner = { workId: string | null; rootThreadId: string | null };

/** Why the owner of a closed source takes no change, and the name it goes by. */
export type ClosedSource = { why: ClosedOwnerWhy; owner?: string };

/**
 * The owners of every source a tree command's effect may change, read before the locks. A Work
 * or lineage owner joins the command's write set (`works`, `lineages`); `judge`, under those
 * locks, says whether a source is closed. A source outside the set throws `TreeOwnersMoved`.
 */
export type TreeOwners = {
  works: string[];
  lineages: string[];
  judge(locked: LockedWorkWriteSet): (source: string) => ClosedSource | null;
};

async function treeOwners(db: Database, sourceIds: ReadonlySet<string>): Promise<TreeOwners> {
  const rows = sourceIds.size
    ? await currentDrizzleDb(db)
        .select({
          id: contextSources.id,
          workId: contextSources.workId,
          rootThreadId: contextSources.rootThreadId,
        })
        .from(contextSources)
        .where(inArray(contextSources.id, [...sourceIds] as never[]))
    : [];
  const owners = new Map<string, SourceOwner>(rows.map((row) => [row.id as string, row]));
  // An account's `user://` sources are no project row's: they have no owner to close.
  for (const id of sourceIds)
    if (!owners.has(id)) owners.set(id, { workId: null, rootThreadId: null });
  const works = [...new Set(rows.flatMap((row) => (row.workId ? [row.workId as string] : [])))];
  const lineages = [
    ...new Set(
      rows.flatMap((row) => (!row.workId && row.rootThreadId ? [row.rootThreadId as string] : [])),
    ),
  ];
  const names = await ownerNames(db, { workIds: works, rootThreadIds: lineages });
  return {
    works,
    lineages,
    judge: (locked) => (source) => {
      const owner = owners.get(source);
      if (!owner) throw new TreeOwnersMoved(source);
      const id = owner.workId ?? owner.rootThreadId;
      if (!id) return null;
      const why = owner.workId
        ? closedOwnerOf(locked.works.get(owner.workId)?.state ?? "missing")
        : closedOwnerOf(locked.lineages.get(id) === "active" ? "active" : "frozen");
      if (!why) return null;
      const name = names.get(id);
      return name ? { why, owner: name } : { why };
    },
  };
}

/**
 * Runs a tree command (Apply, Un-Apply) with the owners of every source its effect may change
 * locked: `sources` reads them without a key, and `run` judges under the locks. When the effect
 * under the list's key changes a source the read missed, the command's transaction rolls back
 * and runs again with that source added, so its answer always matches what commits.
 */
export async function withTreeOwners<T>(
  db: Database,
  sources: () => Promise<ReadonlySet<string>>,
  run: (owners: TreeOwners) => Promise<T>,
): Promise<T> {
  const missed = new Set<string>();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(await treeOwners(db, new Set([...(await sources()), ...missed])));
    } catch (cause) {
      if (!(cause instanceof TreeOwnersMoved) || attempt === 4) throw cause;
      missed.add(cause.source);
    }
  }
}

export const returnedFor = (
  { why, owner }: ClosedSource,
  items?: readonly string[],
): Settlement => ({
  rule: "returned",
  why,
  ...(owner ? { owner } : {}),
  ...(items ? { items: [...items] } : {}),
});
