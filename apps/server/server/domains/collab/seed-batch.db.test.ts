/** PostgreSQL proof that set-wise initial states are indistinguishable from singly seeded documents. */

import { randomUUID } from "node:crypto";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentSnapshots,
  documents,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { createTestRemovalDeps } from "../../test-support/document-removal.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { treeSeeder } from "../../test-support/tree-seed.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createAllowAllFileAccess } from "../file-policy/index.js";
import { createCollabDomain } from "./composition.js";
import { testCollabDeps } from "./test-support/document-link-scopes.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("batch initial states (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 4 });
  let user: string;
  let projectId: string;
  let sourceId: string;
  afterAll(async () => {
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
    await db.insert(contextSources).values({ id: sourceId, projectId, slug: "kb" });
  });

  it("a document seeded in a batch reads, opens and edits like one seeded singly", async () => {
    const collab = createCollabDomain({
      db,
      ...testCollabDeps(db),
      ...createTestRemovalDeps(db),
      fileAccess: createAllowAllFileAccess(),
      workProjectionMutation: createTestWorkProjectionMutation(db),
    });
    const single = randomUUID() as DocumentId;
    const batch = [randomUUID(), randomUUID()] as DocumentId[];
    const seed = treeSeeder(db);
    for (const [index, id] of [single, ...batch].entries())
      await seed.document(sourceId, `doc-${index}`, { id });
    const origin = { type: "system" } as const;
    const text = "# Chapter\n\nOnce upon a time.\n";
    const store = collab;
    await store.seedFromMarkdown(single, store.bindStatic(text), origin);
    const state = store.encodeSeed(store.bindStatic(text), origin);
    await runInDrizzleTransaction(db, () =>
      store.installSeeds(batch.map((documentId) => ({ documentId, state }))),
    );

    const ids = [single, ...batch];
    const rows = await db
      .select({ roomKey: documentSnapshots.roomKey, docKey: documentSnapshots.docKey })
      .from(documentSnapshots)
      .where(
        inArray(
          documentSnapshots.roomKey,
          ids.map((id) => `live:${id}`),
        ),
      );
    // A room's stored docs, by kind: the structure doc and one text doc per text block.
    const shape = (id: DocumentId) =>
      rows
        .filter((row) => row.roomKey === `live:${id}`)
        .map((row) => (row.docKey === "s" ? "s" : "text"))
        .sort();
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

    await db.delete(documents).where(eq(documents.id, single));
  });
});
