/** A pool no larger than the concurrent peer ensures must still drain: one connection each. */
import { randomUUID } from "node:crypto";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { afterAll, expect, it } from "vitest";
import * as Y from "yjs";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import {
  createDrizzleBranchStore,
  createDrizzleBranchWriteBoundary,
} from "./adapters/drizzle-branches.js";
import { createDraftClose } from "./adapters/drizzle-draft-close.js";
import { createDrizzleDraftStore } from "./adapters/drizzle-drafts.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createBranches } from "./domain/branches.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");
const POOL = 3;
const db = createDb(DATABASE_URL, { max: POOL });
afterAll(() => db.$client.end({ timeout: 1 }));

it("ensureThreadPeerDraft from more callers than connections completes", async () => {
  const persistence = createDrizzleCollabPersistence(db);
  const branches = createBranches({
    store: createDrizzleBranchStore(db),
    boundary: createDrizzleBranchWriteBoundary(db, createTestWorkProjectionMutation(db)),
  });
  const store = createDrizzleDraftStore(db, {
    close: createDraftClose(),
    workProjection: createTestWorkProjectionMutation(db),
    live: { journal: persistence.journal },
    branches,
  });
  const userId = randomUUID();
  const projectId = randomUUID();
  const workId = randomUUID();
  const sourceId = randomUUID();
  await db.insert(users).values(conformanceUserValues(userId, "peer-pool"));
  await db.insert(projects).values({ id: projectId, userId, name: "P", slug: `p-${projectId}` });
  await db
    .insert(works)
    .values({ id: workId, projectId, createdByUserId: userId, name: "W", handle: "w1" });
  await db.insert(contextSources).values({
    id: sourceId,
    projectId,
    name: "Manuscript",
    slug: "manuscript",
    scope: "project",
    isPrimary: true,
  });
  const branch = await branches.ensureActiveForWrite({
    workId: workId as never,
    projectId: projectId as never,
    threadId: null,
    userId: userId as never,
  });
  const jobs: { documentId: string; threadId: string }[] = [];
  for (let i = 0; i < POOL * 2; i += 1) {
    const documentId = randomUUID();
    const threadId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      contextSourceId: sourceId,
      name: `d${i}`,
      extension: "",
      fileType: "markdown",
    });
    await db.insert(threads).values({
      rootThreadId: threadId,
      id: threadId,
      projectId,
      createdByUserId: userId,
      title: "t",
      kind: "primary",
      status: "idle",
    });
    await db.insert(threadWorks).values({ threadId, workId, projectId, isPrimary: true });
    await persistence.seeds.seedInitialDocument(
      documentId as never,
      Y.encodeStateAsUpdate(new Y.Doc()),
    );
    await store.ensureDocumentDraft({
      documentId: documentId as never,
      branchId: branch.id,
      liveDoc: createCollabYDoc({ gc: false }),
    });
    jobs.push({ documentId, threadId });
  }
  const all = Promise.all(
    jobs.map((job) =>
      store.ensureThreadPeerDraft({
        documentId: job.documentId as never,
        threadId: job.threadId as never,
        branchId: branch.id,
        liveDoc: async () => createCollabYDoc({ gc: false }),
      }),
    ),
  );
  const outcome = await Promise.race([
    all.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("pool exhausted"), 8000)),
  ]);
  expect(outcome).toBe("done");
}, 30000);
