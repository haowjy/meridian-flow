/** Postgres document-link resolver conformance and per-request lookup coverage. */

import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  folders,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { beforeEach, describe } from "vitest";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../../test-support/rollback-test-database.js";
import type { DocumentLinkCandidate } from "../document-link-resolution.js";
import {
  DOCUMENT_LINK_CONTRACT_IDS,
  type DocumentLinkResolverContractHarness,
  registerDocumentLinkResolverContract,
} from "./__conformance__/document-link-resolver.contract.js";
import { createDrizzleDocumentLinkResolver } from "./drizzle-document-link-resolver.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Drizzle document-link resolver (postgres)", () => {});
} else {
  describe("Drizzle document-link resolver (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000900";
    const MANUSCRIPT_SOURCE_ID = "00000000-0000-4000-8000-000000000907";
    const WORK_SOURCE_ID = "00000000-0000-4000-8000-000000000908";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "document-link-resolver"));
      await db.insert(projects).values({
        id: DOCUMENT_LINK_CONTRACT_IDS.project,
        userId: USER_ID,
        name: "Resolver Project",
        slug: "resolver-project",
      });
      await db.insert(works).values({
        id: DOCUMENT_LINK_CONTRACT_IDS.work,
        projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
        createdByUserId: USER_ID,
        name: "Resolver Work",
        slug: "resolver-work",
      });
      await db.insert(contextSources).values([
        {
          id: MANUSCRIPT_SOURCE_ID,
          projectId: DOCUMENT_LINK_CONTRACT_IDS.project,
          name: "Manuscript",
          slug: "manuscript",
          scope: "project",
        },
        {
          id: WORK_SOURCE_ID,
          workId: DOCUMENT_LINK_CONTRACT_IDS.work,
          name: "Scratch",
          slug: "scratch",
          scope: "work",
        },
      ]);
    });

    registerDocumentLinkResolverContract("drizzle", async () => {
      const folderIds = new Map<string, string>();
      return {
        resolver: createDrizzleDocumentLinkResolver(db),
        async remember(candidate: DocumentLinkCandidate) {
          const sourceId = candidate.scheme === "work" ? WORK_SOURCE_ID : MANUSCRIPT_SOURCE_ID;
          const pathParts = candidate.path.split("/");
          const filename = pathParts.pop();
          if (!filename) throw new Error("candidate path needs a filename");
          let parentId: string | null = null;
          let accumulated = "";
          for (const folderName of pathParts) {
            accumulated = accumulated ? `${accumulated}/${folderName}` : folderName;
            const key = `${sourceId}:${accumulated}`;
            let folderId = folderIds.get(key);
            if (!folderId) {
              folderId = crypto.randomUUID();
              folderIds.set(key, folderId);
              await db.insert(folders).values({
                id: folderId,
                contextSourceId: sourceId,
                parentId,
                name: folderName,
              });
            }
            parentId = folderId;
          }
          const finalDot = filename.lastIndexOf(".");
          const name = finalDot > 0 ? filename.slice(0, finalDot) : filename;
          const extension = finalDot > 0 ? filename.slice(finalDot + 1) : "";
          await db.insert(documents).values({
            id: candidate.documentId,
            contextSourceId: sourceId,
            folderId: parentId,
            name,
            extension,
            metadata: { aliases: candidate.aliases ?? [] },
          });
        },
      } satisfies DocumentLinkResolverContractHarness;
    });
  });
}
