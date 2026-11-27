import { AsyncLocalStorage } from "node:async_hooks";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import type { Database } from "@meridian/database";
import { contextSources } from "@meridian/database/schema";
import type { UndoAnswer, UndoReport } from "@meridian/project-tree";
import { inArray } from "drizzle-orm";
import { closedOwnerOf, mergeOwnerLocks, type OwnerLocks } from "./draft-owner.js";
import {
  currentDrizzleDb,
  isInCommandTransaction,
  isInDrizzleTransaction,
  isRetryableTransactionError,
} from "./drizzle-transaction.js";
import { type LockedOwners, readOwners } from "./work-lifecycle-lock.js";

export class TreeOwnersMoved extends Error {
  constructor(
    readonly sources: readonly string[] = [],
    readonly owners: OwnerLocks = mergeOwnerLocks(),
  ) {
    super("the command's owners changed while it locked them; it runs again");
    this.name = "TreeOwnersMoved";
  }
}

/**
 * Whether a catch that turns errors into an answer must rethrow `cause`: a moved owner, or a
 * deadlock or serialization failure inside a command, whose transaction then runs again. Outside a
 * command nothing reruns a deadlock, so the catch answers it as before.
 */
export function restartsTransaction(cause: unknown): boolean {
  return (
    cause instanceof TreeOwnersMoved ||
    (isRetryableTransactionError(cause) && isInCommandTransaction())
  );
}

const MAX_UNNAMED_RESTARTS = 4;

export type Learned = { sources: ReadonlySet<string>; owners: OwnerLocks };

const enclosing = new AsyncLocalStorage<{ learned: Learned }>();

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

type SourceOwner = { workId: string | null; rootThreadId: string | null };

export function closedWhyOf(owner: SourceOwner, owners: LockedOwners): ClosedOwnerWhy | null {
  if (owner.workId) return closedOwnerOf(owners.works.get(owner.workId)?.state ?? "missing");
  if (owner.rootThreadId)
    return closedOwnerOf(
      owners.lineages.get(owner.rootThreadId) === "active" ? "active" : "frozen",
    );
  return null;
}

export type ClosedSource = { why: ClosedOwnerWhy };

type SourceFate = ({ kind: "closed" } & ClosedSource) | { kind: "gone" };

export type TreeJudge = {
  fate(source: string): SourceFate | null;
  closed(source: string): boolean;
  assertLocked(): void;
};

export type TreeOwners = {
  works: string[];
  lineages: string[];
  judge(locked?: LockedOwners): Promise<TreeJudge>;
};

export const NO_OWNERS: TreeOwners = {
  works: [],
  lineages: [],
  judge: async () => ({ fate: () => null, closed: () => false, assertLocked() {} }),
};

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

export function withTreeOwners<T>(
  db: Database,
  sources: () => Promise<ReadonlySet<string>>,
  run: (owners: TreeOwners) => Promise<T>,
): Promise<T> {
  return untilOwnersHold(async (learned) =>
    run(await treeOwners(db, new Set([...(await sources()), ...learned.sources]), learned.owners)),
  );
}

export const closedAnswer = (judge: TreeJudge, source: string): "closed" | "purged" =>
  judge.fate(source)?.kind === "gone" ? "purged" : "closed";

export function answerOf(report: UndoReport, judge: TreeJudge): UndoAnswer {
  if (report.answer !== "undoes") return report.answer;
  const source = report.sources.find(judge.closed);
  return source === undefined ? "undoes" : closedAnswer(judge, source);
}
