/** Integration proof for per-turn edited document discovery. */
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { LIVE_SCOPE } from "../adapters/drizzle-agent-edit-scope.js";
import { createDrizzleTurnLiveLineageStore } from "../adapters/drizzle-turn-live-lineage.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000601" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000602";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000603";
const DOC_ID = "00000000-0000-4000-8000-000000000604" as DocumentId;
const DOC_B_ID = "00000000-0000-4000-8000-000000000607" as DocumentId;
const THREAD_ID = "00000000-0000-4000-8000-000000000605" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000606" as TurnId;
const OTHER_TURN_ID = "00000000-0000-4000-8000-000000000608" as TurnId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("turn live lineage (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("turn live lineage (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const {
      agentEditMutations,
      agentEditWidCounters,
      contextSources,
      documentYjsDrafts,
      documentYjsDraftUpdates,
      documentYjsReversals,
      documents,
      folders,
      projects,
      threads,
      turns,
      users,
    } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");

    const db = createDb(DATABASE_URL, { max: 2 });
    const liveLineage = createDrizzleTurnLiveLineageStore(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        documentYjsDraftUpdates,
        documentYjsDrafts,
        agentEditMutations,
        agentEditWidCounters,
        documentYjsReversals,
        turns,
        threads,
        documents,
        folders,
        contextSources,
        projects,
        users,
      ]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "turn-live-lineage"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Live Lineage Project",
        slug: "live-lineage-project",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Live Lineage Source",
        slug: "manuscript",
        scope: "project",
      });
      await db.insert(documents).values([
        {
          id: DOC_ID,
          contextSourceId: CONTEXT_SOURCE_ID,
          name: "chapter",
          extension: "md",
          fileType: "markdown",
        },
        {
          id: DOC_B_ID,
          contextSourceId: CONTEXT_SOURCE_ID,
          name: "chapter-b",
          extension: "md",
          fileType: "markdown",
        },
      ]);
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Live Lineage Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(turns).values([
        { id: TURN_ID, threadId: THREAD_ID, role: "assistant", status: "complete" },
        {
          id: OTHER_TURN_ID,
          threadId: THREAD_ID,
          parentTurnId: TURN_ID,
          role: "assistant",
          status: "complete",
        },
      ]);
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("keeps live undo authority empty for a draft-only turn", async () => {
      await insertMutation({ documentId: DOC_ID, scopeId: "draft-scope", writeId: "draft-write" });

      await expect(liveLineage.listLiveDocumentIdsForTurn(THREAD_ID, TURN_ID)).resolves.toEqual([]);
      await expect(liveLineage.listEditedDocumentIdsForTurn(THREAD_ID, TURN_ID)).resolves.toEqual([
        { documentId: DOC_ID, scope: "draft" },
      ]);
    });

    it("returns the document for an accepted-draft live mutation", async () => {
      await insertMutation({ documentId: DOC_ID, scopeId: "draft-scope", writeId: "draft-write" });
      await insertMutation({ documentId: DOC_ID, scopeId: LIVE_SCOPE, writeId: "draft-accept:1" });
      await insertMutation({
        documentId: DOC_B_ID,
        scopeId: LIVE_SCOPE,
        turnId: OTHER_TURN_ID,
        writeId: "other-turn-write",
      });

      await expect(liveLineage.listLiveDocumentIdsForTurn(THREAD_ID, TURN_ID)).resolves.toEqual([
        DOC_ID,
      ]);
      await expect(liveLineage.listEditedDocumentIdsForTurn(THREAD_ID, TURN_ID)).resolves.toEqual([
        { documentId: DOC_ID, scope: "draft" },
        { documentId: DOC_ID, scope: "live" },
      ]);
    });

    async function insertMutation(input: {
      documentId: DocumentId;
      scopeId: string;
      writeId: string;
      turnId?: TurnId;
    }) {
      await db.insert(agentEditMutations).values({
        wId: 1,
        documentId: input.documentId,
        threadId: THREAD_ID,
        scopeId: input.scopeId,
        turnId: input.turnId ?? TURN_ID,
        writeId: input.writeId,
        status: "active",
        createdSeq: 1,
      });
    }
  });
}
