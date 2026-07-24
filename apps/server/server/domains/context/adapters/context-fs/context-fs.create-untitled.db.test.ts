/** Persisted live-document coverage for client-owned untitled creation. */

import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDrizzleDocumentAccess } from "../../../../lib/document-access.js";
import { truncateDrizzleTables } from "../../../../test-support/drizzle-reset.js";
import { createCollabDomain } from "../../../collab/index.js";
import { ContextFS } from "./context-fs.js";
import { DrizzleContextDocumentStore, DrizzleContextTreeMutationStore } from "./drizzle-store.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("ContextFS untitled collab persistence (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("ContextFS untitled collab persistence (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000911";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000912";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000913";
    const DOCUMENT_ID = "00000000-0000-4000-8000-000000000914";
    const db = createDb(DATABASE_URL, { max: 4 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        documentYjsCheckpoints,
        documentYjsHeads,
        documentYjsUpdates,
        folders,
        documents,
        contextSources,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "untitled-collab"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Untitled Collab",
        slug: "untitled-collab",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
    });

    afterAll(async () => db.$client.end());

    it("persists and reloads a live document with zero CRDT structs", async () => {
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
      });
      const store = new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID });
      const fs = new ContextFS({
        store,
        mutationStore: new DrizzleContextTreeMutationStore(db),
        documentSync: collab,
        scheme: "manuscript",
      });

      await expect(
        fs.createUntitledDocument("", {
          documentId: DOCUMENT_ID,
          origin: { type: "system" },
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { status: "created", documentId: DOCUMENT_ID },
      });
      await expect(db.select().from(documentYjsCheckpoints)).resolves.toHaveLength(1);

      const persistedState = await collab.loadHocuspocusDocument(DOCUMENT_ID);
      if (!persistedState) throw new Error("untitled live document was not persisted");
      const reloaded = new Y.Doc({ gc: false });
      Y.applyUpdate(reloaded, persistedState);
      const structs = (
        reloaded as unknown as { store: { clients: Map<number, readonly unknown[]> } }
      ).store.clients;
      expect([...structs.values()].flat()).toHaveLength(0);
    });
  });
}
