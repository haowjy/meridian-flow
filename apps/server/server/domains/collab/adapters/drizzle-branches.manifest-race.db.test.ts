/** PostgreSQL regression for concurrent cold manifest identity allocation. */
import { randomUUID } from "node:crypto";

import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, projects, users } from "@meridian/database/schema";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createDrizzleBranchStore } from "./drizzle-branches.js";
import { createDrizzleCollabPersistence } from "./drizzle-journal.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DB suites require DATABASE_URL");

describe("Drizzle manifest identity allocation", () => {
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

  it("adopts one manifest identity across concurrent cold resolutions", async () => {
    const userId = randomUUID();
    const projectId = randomUUID();
    const contextSourceId = randomUUID();
    const contentDocumentId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "manifest-race"));
    await db.insert(projects).values({
      id: projectId,
      userId,
      name: "Manifest Race Project",
      slug: `manifest-race-${projectId}`,
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
});
