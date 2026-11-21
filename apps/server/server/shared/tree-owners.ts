import { AsyncLocalStorage } from "node:async_hooks";
import type { ClosedOwnerWhy, Settlement } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import type { UndoAnswer, UndoReport } from "@meridian/project-tree";
import { inArray } from "drizzle-orm";
import { closedOwnerOf, mergeOwnerLocks, type OwnerLocks } from "./draft-owner.js";
import { currentDrizzleDb, isInDrizzleTransaction } from "./drizzle-transaction.js";
import { type LockedOwners, readOwners } from "./work-lifecycle-lock.js";

/**
 * A command's effect changed sources, or needs Works and lineages, whose owners it did not lock:
 * what had changed between the read the locks were chosen from and the effect's own locks. The
 * command runs again, from its transaction's start, with every one of them in the set
 * (`untilOwnersHold`). One that names nothing asks only for a fresh read (a thread joined a
 * Work's tree meanwhile).
 */
export class TreeOwnersMoved extends Error {
  constructor(
    readonly sources: readonly string[] = [],
    readonly owners: OwnerLocks = mergeOwnerLocks(),
  ) {
    super("the command's owners changed while it locked them; it runs again");
    this.name = "TreeOwnersMoved";
  }
}

const MAX_UNNAMED_RESTARTS = 4;

/** What the commands that ran before have found they need. */
export type Learned = { sources: ReadonlySet<string>; owners: OwnerLocks };

const enclosing = new AsyncLocalStorage<{ learned: Learned }>();

/**
 * Runs `run` again, from its transaction's start, while it throws `TreeOwnersMoved`, with all it
 * has learned. Each restart that names something adds a source or an owner and a project has
 * finitely many, so it ends; one that names only what is known already is a bug in what it
 * asked, and escapes. A restart that names nothing learns nothing, so only a few are allowed.
 *
 * A command has one restart loop, and it belongs to whoever owns the transaction (`runCommand`):
 * a restart rolls the transaction back before the next attempt takes its first lock. A call made
 * inside another's `run`, or inside a transaction nobody here owns, is not a loop. It runs once
 * with what the outer one has learned (nothing, without one) and lets `TreeOwnersMoved` reach
 * the owner, so the owner any layer finds is locked by every layer on the next attempt, and a
 * layer that committed is never run again.
 */
export async function untilOwnersHold<T>(run: (learned: Learned) => Promise<T>): Promise<T> {
  const outer = enclosing.getStore();
  if (outer) return run(outer.learned);
  if (isInDrizzleTransaction())
    return run({ sources: new Set<string>(), owners: mergeOwnerLocks() });
  const state = { learned: { sources: new Set<string>(), owners: mergeOwnerLocks() } as Learned };
  let unnamed = 0;
  for (;;) {
    try {
      return await enclosing.run(state, () => run(state.learned));
    } catch (cause) {
      if (!(cause instanceof TreeOwnersMoved)) throw cause;
      const { learned } = state;
      const sources = new Set([...learned.sources, ...cause.sources]);
      const owners = mergeOwnerLocks(learned.owners, cause.owners);
      const named =
        cause.sources.length + cause.owners.workIds.length + cause.owners.lineageRootIds.length > 0;
      const grew =
        sources.size > learned.sources.size ||
        owners.workIds.length > learned.owners.workIds.length ||
        owners.lineageRootIds.length > learned.owners.lineageRootIds.length;
      if ((named && !grew) || (!named && ++unnamed > MAX_UNNAMED_RESTARTS)) throw cause;
      state.learned = { sources, owners };
    }
  }
}

/** Whose notes a source is: a Work's or a chat lineage's; neither for a project's or an account's. */
type SourceOwner = { workId: string | null; rootThreadId: string | null };

/**
 * Why a source's owner closes it, or null while it takes changes: the one rule, read from the
 * owners' lifecycles (under their locks for a writer, as they stand for a reader). A Work that
 * is archived, deleted or missing closes its notes, and so does a chat lineage with no live
 * member. A project's, an account's and a chat's uploads sources have no such owner.
 */
export function closedWhyOf(owner: SourceOwner, owners: LockedOwners): ClosedOwnerWhy | null {
  if (owner.workId) return closedOwnerOf(owners.works.get(owner.workId)?.state ?? "missing");
  if (owner.rootThreadId)
    return closedOwnerOf(
      owners.lineages.get(owner.rootThreadId) === "active" ? "active" : "frozen",
    );
  return null;
}

/** Why the owner of a closed source takes no change. */
export type ClosedSource = { why: ClosedOwnerWhy };

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
  /** `locked` is what the caller read under the locks; absent, the owners' lifecycles as they stand. */
  judge(locked?: LockedOwners): Promise<TreeJudge>;
};

/** No source to judge: a command that changes none takes the locks of none. */
export const NO_OWNERS: TreeOwners = {
  works: [],
  lineages: [],
  judge: async () => ({ fate: () => null, closed: () => false, assertLocked() {} }),
};

/** The owners of `sourceIds`, plus the Works and lineages a restart learned the command needs. */
export async function treeOwners(
  db: Database,
  sourceIds: ReadonlySet<string>,
  learned: OwnerLocks = mergeOwnerLocks(),
): Promise<TreeOwners> {
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
  const sourceWorks = rows.flatMap((row) => (row.workId ? [row.workId as string] : []));
  const sourceLineages = rows.flatMap((row) =>
    !row.workId && row.rootThreadId ? [row.rootThreadId as string] : [],
  );
  const { workIds: works, lineageRootIds: lineages } = mergeOwnerLocks(learned, {
    workIds: sourceWorks,
    lineageRootIds: sourceLineages,
  });
  return {
    works,
    lineages,
    async judge(known) {
      const locked = known ?? (await readOwners(db, works, lineages));
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
        const why = closedWhyOf(owner, locked);
        if (!why) return null;
        return { kind: "closed", why };
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
 * Runs a tree command (Apply, Un-Apply, an Undo) with the owners of every source its effect may
 * change locked: `sources` reads them without a key, and `run` judges under the locks. When the
 * effect under the list's key changes sources the read missed, the command's transaction rolls
 * back and runs again with all of them added, so its answer always matches what commits.
 */
export function withTreeOwners<T>(
  db: Database,
  sources: () => Promise<ReadonlySet<string>>,
  run: (owners: TreeOwners) => Promise<T>,
): Promise<T> {
  return untilOwnersHold(async (learned) =>
    run(await treeOwners(db, new Set([...(await sources()), ...learned.sources]), learned.owners)),
  );
}

/**
 * What an Undo of a record whose opposite would change `source` comes to: `purged` when the
 * source is gone, `closed` while its owner is.
 */
export const closedAnswer = (judge: TreeJudge, source: string): "closed" | "purged" =>
  judge.fate(source)?.kind === "gone" ? "purged" : "closed";

/** A report of what an Undo would do (`undoReports`), as the judge reads it. */
export function answerOf(report: UndoReport, judge: TreeJudge): UndoAnswer {
  if (report.answer !== "undoes") return report.answer;
  const source = report.sources.find(judge.closed);
  return source === undefined ? "undoes" : closedAnswer(judge, source);
}

export const returnedFor = ({ why }: ClosedSource, items?: readonly string[]): Settlement => ({
  rule: "returned",
  why,
  ...(items ? { items: [...items] } : {}),
});
