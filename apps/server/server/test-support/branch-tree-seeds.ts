/**
 * The branch-tree DB tests' world and seed verbs (contract §16.1): a project with its
 * sources, Works with their primary threads, rows written the way the product's creates
 * leave them, written through `treeListStore.submit` (`tree-seed.ts`). No composed runtime: command
 * verbs, the link resolve route's answer among them, live in `branch-tree-commands.ts`.
 *
 * Paths are source-relative, Manuscript by default; prefix `kb://` or `unfiled://` for
 * the other project sources, or `user://` for the account's home folder (its own source,
 * made with the account and shared by every world of the account).
 */

import { randomUUID } from "node:crypto";
import type {
  ContextSourceId,
  DocumentId,
  ProjectId,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { formatWorkHandle, type WorkHandle } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "../domains/collab/adapters/drizzle-branches.js";
import { type Branches, createBranches } from "../domains/collab/domain/branches.js";
import type { Branch } from "../domains/collab/domain/ports/branch-store.js";
import { provisionWorkScratch } from "../domains/context/context-source-provisioning.js";
import { treeSeeder } from "./tree-seed.js";
import { createTestWorkProjectionMutation } from "./work-projection.js";
export type ScenarioSource = "manuscript" | "kb" | "unfiled" | "user";

export type ScenarioWork = {
  id: WorkId;
  handle: WorkHandle;
  threadId: ThreadId;
  turnId: string;
  mode: "draft" | "direct";
};

export interface BranchTreeWorld {
  /** The database the world lives in. */
  db: Database;
  project: {
    id: ProjectId;
    userId: UserId;
    sources: Record<ScenarioSource, ContextSourceId>;
  };
  /** The production branches resolver over this scenario's database. */
  branches: Branches;
  /** Every Work this world made, in order. */
  works(): readonly WorkId[];
  /** A Work and its primary thread, which writes in `mode`. */
  work(name: string, mode: "draft" | "direct"): Promise<ScenarioWork>;
  /** Another thread whose primary Work is `work`, in that Work's mode. */
  thread(work: ScenarioWork): Promise<ScenarioWork>;
  /** The draft the Work names. */
  branchOf(work: ScenarioWork): Promise<Branch>;
  /** A live document, with live folders made as needed. */
  seedLive(path: string): Promise<DocumentId>;
  /** A live folder chain; returns the leaf. */
  seedLiveFolder(path: string): Promise<string>;
  /**
   * A document the Work's draft created: a `create` record in its view (`{ draft: branchId }`)
   * at the path.
   */
  seedHidden(work: ScenarioWork, path: string): Promise<DocumentId>;
  /** A registry row for an ahead ref at `path`, settled live to `settledTo` if given. */
  seedAhead(path: string, options?: { settledTo?: DocumentId }): Promise<string>;
}

const SOURCES = ["manuscript", "kb", "unfiled"] as const;

/** A source-qualified scenario path's scheme and source-relative path. */
export function sourceOf(path: string): { scheme: ScenarioSource; rel: string } {
  const parsed = parseUnifiedContextUri(path);
  if (!parsed.ok)
    throw new Error(`Scenario path ${path} is not an address: ${parsed.error.reason}`);
  return { scheme: parsed.value.scheme as ScenarioSource, rel: parsed.value.path };
}

/** The account's home folder (`user://`), which the account's insert made. */
export async function accountUserSource(db: Database, userId: UserId): Promise<ContextSourceId> {
  const [source] = await db
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(and(eq(contextSources.scope, "account"), eq(contextSources.userId, userId)))
    .limit(1);
  if (!source) throw new Error(`Account ${userId} has no home folder source`);
  return source.id;
}

/** A world in a new account, or another project of `options.account`'s. */
export async function branchTreeWorld(
  db: Database,
  options: { account?: UserId } = {},
): Promise<BranchTreeWorld> {
  const userId = options.account ?? (randomUUID() as UserId);
  const projectId = randomUUID() as ProjectId;
  // One user per scenario unless shared, so a case may build several.
  if (!options.account) {
    await db
      .insert(users)
      .values(conformanceUserValues(userId, `branch-tree-scenario-${userId.slice(0, 8)}`));
  }
  await db.insert(projects).values({
    id: projectId,
    userId,
    name: "Serial",
    slug: `serial-${projectId.slice(0, 8)}`,
  });
  await db.insert(works).values({
    projectId,
    createdByUserId: userId,
    name: "No Work",
    isNoWork: true,
  });
  const projectSources = Object.fromEntries(
    await Promise.all(
      SOURCES.map(async (slug, index) => {
        const [row] = await db
          .insert(contextSources)
          .values({
            projectId,
            slug,
            sortOrder: index,
          })
          .returning({ id: contextSources.id });
        if (!row) throw new Error(`Source ${slug} was not inserted`);
        return [slug, row.id] as const;
      }),
    ),
  ) as Record<(typeof SOURCES)[number], ContextSourceId>;
  return branchTreeWorldOver(db, {
    id: projectId,
    userId,
    sources: { ...projectSources, user: await accountUserSource(db, userId) },
  });
}

/**
 * A world over a project that already exists (a populated upgrade's, say): its sources
 * and the Works the scenario names, which `works()` lists before any it makes.
 */
export function branchTreeWorldOver(
  db: Database,
  project: BranchTreeWorld["project"],
  existingWorks: readonly WorkId[] = [],
): BranchTreeWorld {
  const { id: projectId, userId, sources } = project;
  const branches = createBranches({
    store: createDrizzleBranchStore(db),
    boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
  });
  const madeWorks: WorkId[] = [...existingWorks];

  function locate(path: string) {
    const { scheme, rel } = sourceOf(path);
    return { sourceId: sources[scheme], rel };
  }

  const seeds = treeSeeder(db);

  /** A thread with one assistant turn, primary in `workId`. */
  async function insertThread(title: string, workId: WorkId, mode: ScenarioWork["mode"]) {
    const threadId = randomUUID() as ThreadId;
    const turnId = randomUUID();
    await db.insert(threads).values({
      id: threadId,
      projectId,
      createdByUserId: userId,
      rootThreadId: threadId,
      title,
      aiWriteMode: mode,
    });
    await db.insert(turns).values({
      id: turnId,
      threadId,
      position: 1,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await db.insert(threadWorks).values({ threadId, workId, projectId });
    return { threadId, turnId };
  }

  async function branchOf(work: ScenarioWork): Promise<Branch> {
    const draft = await branches.ofOwner({ kind: "work", workId: work.id });
    if (!draft) throw new Error(`Work ${work.id} names no draft`);
    return draft;
  }

  return {
    db,
    project,
    branches,
    works: () => madeWorks,
    async work(name, mode) {
      const handle = formatWorkHandle(madeWorks.length + 1);
      const [work] = await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name, handle, defaultAiWriteMode: mode })
        .returning({ id: works.id });
      if (!work) throw new Error(`Work ${name} was not inserted`);
      await provisionWorkScratch(db, work.id);
      // As a chat made with an explicit mode: it writes that way and seeds the Work's default.
      const { threadId, turnId } = await insertThread(name, work.id, mode);
      madeWorks.push(work.id);
      return { id: work.id, handle, threadId, turnId, mode };
    },
    async thread(work) {
      const { threadId, turnId } = await insertThread(
        `${work.handle} (second)`,
        work.id,
        work.mode,
      );
      return { ...work, threadId, turnId };
    },
    branchOf,
    async seedLive(path) {
      const { sourceId, rel } = locate(path);
      return (await seeds.document(sourceId, rel)) as DocumentId;
    },
    async seedLiveFolder(path) {
      const { sourceId, rel } = locate(path);
      return seeds.folder(sourceId, rel);
    },
    async seedHidden(work, path) {
      const branch = await branchOf(work);
      const { sourceId, rel } = locate(path);
      return (await seeds.document(sourceId, rel, { view: { draft: branch.id } })) as DocumentId;
    },
    async seedAhead(path, aheadOptions = {}) {
      const { scheme, rel } = sourceOf(path);
      const aheadId = randomUUID();
      await db.insert(linkAheadRefs).values({
        aheadId,
        projectId,
        scheme,
        path: rel,
        ...(aheadOptions.settledTo
          ? { settledDocumentId: aheadOptions.settledTo, settledAt: new Date() }
          : {}),
      });
      return aheadId;
    },
  };
}
