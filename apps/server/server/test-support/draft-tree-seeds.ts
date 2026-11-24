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
  createDrizzleDraftStore,
  createDrizzleDraftWriteBoundary,
} from "../domains/collab/adapters/drizzle-drafts.js";
import { createDrafts, type Drafts } from "../domains/collab/domain/drafts.js";
import type { Draft } from "../domains/collab/domain/ports/draft-store.js";
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

export interface DraftTreeWorld {
  db: Database;
  project: {
    id: ProjectId;
    userId: UserId;
    sources: Record<ScenarioSource, ContextSourceId>;
  };
  drafts: Drafts;
  works(): readonly WorkId[];
  work(name: string, mode: "draft" | "direct"): Promise<ScenarioWork>;
  thread(work: ScenarioWork): Promise<ScenarioWork>;
  draftOf(work: ScenarioWork): Promise<Draft>;
  seedLive(path: string): Promise<DocumentId>;
  seedLiveFolder(path: string): Promise<string>;
  seedHidden(work: ScenarioWork, path: string): Promise<DocumentId>;
  seedAhead(path: string, options?: { settledTo?: DocumentId }): Promise<string>;
}

const SOURCES = ["manuscript", "kb", "unfiled"] as const;

export function sourceOf(path: string): { scheme: ScenarioSource; rel: string } {
  const parsed = parseUnifiedContextUri(path);
  if (!parsed.ok)
    throw new Error(`Scenario path ${path} is not an address: ${parsed.error.reason}`);
  return { scheme: parsed.value.scheme as ScenarioSource, rel: parsed.value.path };
}

export async function accountUserSource(db: Database, userId: UserId): Promise<ContextSourceId> {
  const [source] = await db
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(and(eq(contextSources.scope, "account"), eq(contextSources.userId, userId)))
    .limit(1);
  if (!source) throw new Error(`Account ${userId} has no home folder source`);
  return source.id;
}

export async function draftTreeWorld(
  db: Database,
  options: { account?: UserId } = {},
): Promise<DraftTreeWorld> {
  const userId = options.account ?? (randomUUID() as UserId);
  const projectId = randomUUID() as ProjectId;
  if (!options.account) {
    await db
      .insert(users)
      .values(conformanceUserValues(userId, `draft-tree-scenario-${userId.slice(0, 8)}`));
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
  return draftTreeWorldOver(db, {
    id: projectId,
    userId,
    sources: { ...projectSources, user: await accountUserSource(db, userId) },
  });
}

export function draftTreeWorldOver(
  db: Database,
  project: DraftTreeWorld["project"],
  existingWorks: readonly WorkId[] = [],
): DraftTreeWorld {
  const { id: projectId, userId, sources } = project;
  const drafts = createDrafts({
    store: createDrizzleDraftStore(db),
    boundary: createDrizzleDraftWriteBoundary(db, createTestWorkProjectionMutation(db)),
  });
  const madeWorks: WorkId[] = [...existingWorks];

  function locate(path: string) {
    const { scheme, rel } = sourceOf(path);
    return { sourceId: sources[scheme], rel };
  }

  const seeds = treeSeeder(db);

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

  async function draftOf(work: ScenarioWork): Promise<Draft> {
    const draft = await drafts.ofOwner({ kind: "work", workId: work.id });
    if (!draft) throw new Error(`Work ${work.id} names no draft`);
    return draft;
  }

  return {
    db,
    project,
    drafts,
    works: () => madeWorks,
    async work(name, mode) {
      const handle = formatWorkHandle(madeWorks.length + 1);
      const [work] = await db
        .insert(works)
        .values({ projectId, createdByUserId: userId, name, handle, defaultAiWriteMode: mode })
        .returning({ id: works.id });
      if (!work) throw new Error(`Work ${name} was not inserted`);
      await provisionWorkScratch(db, work.id);
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
    draftOf,
    async seedLive(path) {
      const { sourceId, rel } = locate(path);
      return (await seeds.document(sourceId, rel)) as DocumentId;
    },
    async seedLiveFolder(path) {
      const { sourceId, rel } = locate(path);
      return seeds.folder(sourceId, rel);
    },
    async seedHidden(work, path) {
      const draft = await draftOf(work);
      const { sourceId, rel } = locate(path);
      return (await seeds.document(sourceId, rel, { view: { draft: draft.id } })) as DocumentId;
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
