import { type DraftOwnerKey, draftOwnerKey } from "@meridian/contracts";
import type { ClosedOwnerWhy, Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { closedOwnerOf, ownerNames } from "../../../shared/draft-owner.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { LockedWorkWriteSet } from "../../projects/index.js";

/**
 * Tree effects changed sources whose owners the command did not lock: what live had changed
 * between the read the locks were chosen from and the list's key. The command runs again, from
 * its transaction's start, with every one of them in the set.
 */
export class TreeOwnersMoved extends Error {
  constructor(readonly sources: readonly string[]) {
    super(`tree effects changed sources whose owners were not locked: ${sources.join(", ")}`);
  }
}

/** Whose notes a source is: a Work's or a chat lineage's; neither for a project's or an account's. */
type SourceOwner = { workId: string | null; rootThreadId: string | null };

/** Why the owner of a closed source takes no change, the name it goes by, and which owner it is. */
export type ClosedSource = { why: ClosedOwnerWhy; owner?: string; ownerKey: DraftOwnerKey };

/**
 * What a source takes, judged under the owners' locks: `closed` (an archived or deleted Work, a
 * chat in Trash), `gone` (its `context_sources` row was purged), or neither (null).
 */
export type SourceFate = ({ kind: "closed" } & ClosedSource) | { kind: "gone" };

export type TreeJudge = {
  /** The fate of a source, or null while it takes changes. A source the locks missed is `gone` here and in `assertLocked`. */
  fate(source: string): SourceFate | null;
  /** For the package: no change may land in this source. */
  closed(source: string): boolean;
  /**
   * Called at the end of the tree half: throws `TreeOwnersMoved` with every source asked about
   * whose owner was not locked. Its answers were guesses, so nothing of the attempt may commit.
   */
  assertLocked(): void;
};

/**
 * The owners of every source a tree command's effect may change, read before the locks. A Work
 * or lineage owner joins the command's write set (`works`, `lineages`); `judge`, under those
 * locks, says what each source takes.
 */
export type TreeOwners = {
  works: string[];
  lineages: string[];
  judge(locked: LockedWorkWriteSet): Promise<TreeJudge>;
};

async function treeOwners(db: Database, sourceIds: ReadonlySet<string>): Promise<TreeOwners> {
  const ids = [...sourceIds] as never[];
  const rows = ids.length
    ? await currentDrizzleDb(db)
        .select({
          id: contextSources.id,
          workId: contextSources.workId,
          rootThreadId: contextSources.rootThreadId,
        })
        .from(contextSources)
        .where(inArray(contextSources.id, ids))
    : [];
  const owners = new Map<string, SourceOwner>(rows.map((row) => [row.id as string, row]));
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
    async judge(locked) {
      // A purge can land between the read above and the locks: a source with no row now is gone.
      const alive = ids.length
        ? new Set(
            (
              await currentDrizzleDb(db)
                .select({ id: contextSources.id })
                .from(contextSources)
                .where(inArray(contextSources.id, ids))
            ).map((row) => row.id as string),
          )
        : new Set<string>();
      const missed = new Set<string>();
      const fate = (source: string): SourceFate | null => {
        if (!sourceIds.has(source)) {
          missed.add(source);
          return { kind: "gone" };
        }
        const owner = owners.get(source);
        if (!owner || !alive.has(source)) return { kind: "gone" };
        const id = owner.workId ?? owner.rootThreadId;
        if (!id) return null;
        const why = owner.workId
          ? closedOwnerOf(locked.works.get(owner.workId)?.state ?? "missing")
          : closedOwnerOf(locked.lineages.get(id) === "active" ? "active" : "frozen");
        if (!why) return null;
        const name = names.get(id);
        return {
          kind: "closed",
          why,
          ...(name ? { owner: name } : {}),
          ownerKey: draftOwnerKey(
            owner.workId
              ? { kind: "work", workId: owner.workId as string }
              : { kind: "lineage", rootThreadId: id as string },
          ),
        };
      };
      return {
        fate,
        closed: (source) => fate(source) !== null,
        assertLocked() {
          if (missed.size > 0) throw new TreeOwnersMoved([...missed]);
        },
      };
    },
  };
}

/**
 * Runs a tree command (Apply, Un-Apply) with the owners of every source its effect may change
 * locked: `sources` reads them without a key, and `run` judges under the locks. When the effect
 * under the list's key changes sources the read missed, the command's transaction rolls back
 * and runs again with all of them added, so its answer always matches what commits. Each
 * restart adds a source and a project has finitely many, so it ends.
 */
export async function withTreeOwners<T>(
  db: Database,
  sources: () => Promise<ReadonlySet<string>>,
  run: (owners: TreeOwners) => Promise<T>,
): Promise<T> {
  const missed = new Set<string>();
  for (;;) {
    try {
      return await run(await treeOwners(db, new Set([...(await sources()), ...missed])));
    } catch (cause) {
      if (!(cause instanceof TreeOwnersMoved)) throw cause;
      const before = missed.size;
      for (const source of cause.sources) missed.add(source);
      if (missed.size === before) throw cause;
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
