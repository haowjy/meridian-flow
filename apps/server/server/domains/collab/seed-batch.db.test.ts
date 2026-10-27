/** PostgreSQL proof that set-wise initial states are indistinguishable from singly seeded documents. */

import { randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { createTestRemovalDeps } from "../../test-support/document-removal.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createDrizzleContextCatalog } from "../context/index.js";
import { createAllowAllFileAccess } from "../file-policy/index.js";
import { loadDocumentState } from "./adapters/document-loader.js";
import { createDrizzleCollabPersistence } from "./adapters/drizzle-journal.js";
import { createCollabDomain } from "./composition.js";
import { testLinkDeps } from "./test-support/document-link-scopes.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("batch initial states (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 4 });
  const rooms: Hocuspocus[] = [];
  const domains: ReturnType<typeof createCollabDomain>[] = [];
  let user: string;
  let projectId: string;
  let sourceId: string;
  afterAll(async () => {
    for (const room of rooms.splice(0)) {
      room.closeConnections();
      for (const doc of [...room.documents.values()]) await room.unloadDocument(doc);
    }
    for (const domain of domains.splice(0)) {
      await domain.drainHocuspocusPersistence();
      await domain.dispose();
    }
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });
  beforeEach(async () => {
    await deleteDrizzleRows(db, [users]);
    user = randomUUID();
    projectId = randomUUID();
    sourceId = randomUUID();
    await db.insert(users).values(conformanceUserValues(user, "seed-batch"));
    await db.insert(projects).values({ id: projectId, userId: user, name: "Seeds", slug: "seeds" });
    await db.insert(contextSources).values({ id: sourceId, projectId, name: "KB", slug: "kb" });
  });

  it("a document seeded in a batch reads, opens and edits like one seeded singly", async () => {
    const collab = createCollabDomain({
      db,
      ...testLinkDeps(db),
      ...createTestRemovalDeps(db),
      fileAccess: createAllowAllFileAccess(),
      workProjectionMutation: createTestWorkProjectionMutation(db),
      catalogMutations: createDrizzleContextCatalog(db),
    });
    domains.push(collab);
    const persistence = createDrizzleCollabPersistence(db);
    const hocuspocus = new Hocuspocus({
      yDocOptions: { gc: false, gcFilter: () => true },
      onLoadDocument: async ({ documentName, document }) => {
        const state = await loadDocumentState(persistence.journal, documentName, document);
        if (state) Y.applyUpdate(document, state);
      },
    });
    rooms.push(hocuspocus);
    collab.bindHocuspocus(hocuspocus);
    const single = randomUUID() as DocumentId;
    const batch = [randomUUID(), randomUUID()] as DocumentId[];
    await db.insert(documents).values(
      [single, ...batch].map((id, index) => ({
        id,
        contextSourceId: sourceId,
        name: `doc-${index}`,
        fileType: "markdown",
      })),
    );
    const origin = { type: "system" } as const;
    const text = "# Chapter\n\nOnce upon a time.\n";
    const store = collab;
    await store.seedFromMarkdown(single, store.bindStatic(text), origin);
    const seeds = await Promise.all(
      batch.map((documentId) =>
        store.prepareSeed({
          documentId,
          projectId,
          uri: `kb://doc-${documentId}`,
          content: { ...store.bindStatic(text), holder: { kind: "document", documentId } },
          origin,
        }),
      ),
    );
    const stagingId = randomUUID();
    await runInDrizzleTransaction(db, () =>
      store.stageInitialStates(stagingId, projectId, 1, seeds),
    );
    await runInDrizzleTransaction(db, () => store.commitStagedStates(stagingId));

    const ids = [single, ...batch];
    const heads = await db
      .select()
      .from(documentYjsHeads)
      .where(inArray(documentYjsHeads.documentId, ids));
    const checkpoints = await db
      .select()
      .from(documentYjsCheckpoints)
      .where(inArray(documentYjsCheckpoints.documentId, ids));
    const shape = (id: DocumentId) => {
      const head = heads.find((row) => row.documentId === id);
      const checkpoint = checkpoints.find((row) => row.documentId === id);
      return {
        headSeq: head?.latestUpdateSeq,
        headCheckpointIsSeed: head?.latestCheckpointId === checkpoint?.id,
        authorityMatches:
          checkpoint?.authorityId === head?.authorityId &&
          checkpoint?.authorityGeneration === head?.authorityGeneration,
        next: head?.nextAdmissionSequence,
        upToSeq: checkpoint?.upToSeq,
        reason: checkpoint?.reason,
        manifest: checkpoint?.attributionManifest,
        vectorKept: head?.latestStateVector !== null,
      };
    };
    expect(shape(batch[0] as DocumentId)).toEqual(shape(single));
    expect(shape(batch[1] as DocumentId)).toEqual(shape(single));

    for (const id of ids) {
      const read = await store.readAsMarkdown(id);
      expect(read.ok && read.value).toBe(text);
      const edited = await store.writeDocument({
        documentId: id,
        content: await store.bindMarkdown({
          holder: { documentId: id },
          against: "current",
          markdown: "# Chapter\n\nEdited.\n",
        }),
        origin: { type: "user", actorUserId: user as UserId },
      });
      expect(edited.markdown).toBe("# Chapter\n\nEdited.\n");
    }
    expect(seeds[0]?.markdown).toBe(text);

    await db.delete(documents).where(eq(documents.id, single));
  });
});
