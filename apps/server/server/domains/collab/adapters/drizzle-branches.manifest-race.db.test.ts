/** PostgreSQL contracts for project manifest identity and reconciliation. */
import { randomUUID } from "node:crypto";

import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsCheckpoints,
  documentYjsUpdates,
  projects,
  users,
} from "@meridian/database/schema";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createDrizzleBranchStore } from "./drizzle-branches.js";
import { createDrizzleCollabPersistence } from "./drizzle-journal.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");

describe("Drizzle manifest persistence", () => {
  const db = createDb(DATABASE_URL, { max: 8 });
  const livePersistence = createDrizzleCollabPersistence(db);
  const liveDocs = new Map<string, Y.Doc>();
  const liveCoordinator = {
    async withDocument<T>(documentId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
      let doc = liveDocs.get(documentId);
      if (!doc) {
        doc = createCollabYDoc({ gc: false });
        const snapshot = await livePersistence.journal.read(documentId);
        if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
        for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
        liveDocs.set(documentId, doc);
      }
      return fn(doc);
    },
    async recover() {},
  };
  const store = createDrizzleBranchStore(db, {
    journal: livePersistence.journal,
    lifecycle: livePersistence.lifecycle,
    coordinator: liveCoordinator,
  });

  afterAll(async () => {
    for (const doc of liveDocs.values()) doc.destroy();
    await db.$client.end();
  });

  async function createProjectFixture(label: string) {
    const userId = randomUUID();
    const projectId = randomUUID();
    const contextSourceId = randomUUID();
    const contentDocumentId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, label));
    await db.insert(projects).values({
      id: projectId,
      userId,
      name: `Manifest ${label}`,
      slug: `manifest-${label}-${projectId}`,
    });
    await db.insert(contextSources).values({
      id: contextSourceId,
      projectId,
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
      isPrimary: true,
    });
    await db.insert(documents).values({
      id: contentDocumentId,
      contextSourceId,
      name: "chapter",
      extension: "md",
      fileType: "markdown",
    });
    return { projectId, contextSourceId, contentDocumentId };
  }

  async function manifestHistoryCounts(documentId: string) {
    const [[updates], [checkpoints]] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, documentId as never)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, documentId as never)),
    ]);
    return { updates: updates?.count ?? 0, checkpoints: checkpoints?.count ?? 0 };
  }

  it("adopts one manifest identity across concurrent cold resolutions", async () => {
    const { projectId, contextSourceId } = await createProjectFixture("race");

    const resolutions = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.resolveManifestMembership({ projectId: projectId as never }),
      ),
    );
    const [documentId] = [...new Set(resolutions.map((resolution) => resolution.documentId))];

    expect(documentId).toBeDefined();
    expect(resolutions.map((resolution) => resolution.documentId)).toEqual(
      Array.from({ length: 8 }, () => documentId),
    );

    const activeManifests = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.contextSourceId, contextSourceId),
          eq(documents.kind, "manifest"),
          isNull(documents.deletedAt),
        ),
      );
    expect(activeManifests).toEqual([{ id: documentId }]);
  });

  it("does not journal an unchanged live manifest reconciliation", async () => {
    const { projectId, contentDocumentId } = await createProjectFixture("idempotence");

    const first = await store.resolveManifestMembership({ projectId: projectId as never });
    const firstHistory = await manifestHistoryCounts(first.documentId);
    const second = await store.resolveManifestMembership({ projectId: projectId as never });

    expect(first).toEqual({ documentId: first.documentId, members: [contentDocumentId] });
    expect(second).toEqual(first);
    expect(firstHistory).toEqual({ updates: 1, checkpoints: 1 });
    await expect(manifestHistoryCounts(first.documentId)).resolves.toEqual(firstHistory);
  });
});
