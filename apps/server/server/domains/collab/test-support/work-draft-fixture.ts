/** Shared persisted Work draft fixture for collab operation integration tests. */
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  projects,
  threads,
  threadWorks,
  turns,
  users,
} from "@meridian/database/schema";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import {
  DOCUMENT_RUNTIME_RESET_TABLES,
  deleteDrizzleRows,
} from "../../../test-support/drizzle-reset.js";
import { treeSeeder } from "../../../test-support/tree-seed.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { insertWorks } from "../../../test-support/work-rows.js";
import { createAllowAllFileAccess } from "../../file-policy/index.js";
import { UNSUPPORTED_AHEAD_REFS } from "../adapters/in-memory/static-document-link-scopes.js";
import { createCollabDomain } from "../composition.js";
import { createTestDocumentLinkScopes } from "./document-link-scopes.js";

export const USER_ID = "00000000-0000-4000-8000-000000000701";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000702";
export const SOURCE_ID = "00000000-0000-4000-8000-000000000703";
export const WORK_ID = "00000000-0000-4000-8000-000000000704";
export const DOC_ID = "00000000-0000-4000-8000-000000000705";
export const THREAD_ID = "00000000-0000-4000-8000-000000000706";
export const TURN_ID = "00000000-0000-4000-8000-000000000707";
export const TURN_2_ID = "00000000-0000-4000-8000-000000000708";
const TURN_3_ID = "00000000-0000-4000-8000-000000000709";
export const CREATED_DOC_ID = "00000000-0000-4000-8000-000000000710";
/** The draft the Work names. */
export const WORK_DRAFT_ID = "workfixture1";

export function createWorkDraftFixture(db: Database) {
  const collabs: Array<{ dispose(): Promise<void> }> = [];
  /** Without custom links, use the real tree-backed scope, as production does. */
  const createTestCollab = (links?: ReturnType<typeof createTestDocumentLinkScopes>) => {
    const collab = createCollabDomain({
      links: links ?? createTestDocumentLinkScopes(db),
      aheadRefs: UNSUPPORTED_AHEAD_REFS,
      fileAccess: createAllowAllFileAccess(),
      db,
      workProjectionMutation: createTestWorkProjectionMutation(db),
      ...createTestRemovalDeps(db),
    });
    collabs.push(collab);
    return collab;
  };

  const dispose = async () => {
    for (const collab of collabs.splice(0)) await collab.dispose();
  };

  async function reset() {
    await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
    await db.insert(users).values(conformanceUserValues(USER_ID, "collab-reverse"));
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
    await insertWorks(db, {
      id: WORK_ID,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      name: "Work",
      handle: "w1",
      draftId: WORK_DRAFT_ID,
    });
    await db.insert(contextSources).values({
      id: SOURCE_ID,
      projectId: PROJECT_ID,
      slug: "manuscript",
      scope: "project",
    });
    await treeSeeder(db).document(SOURCE_ID, "chapter", { id: DOC_ID });
    await db.insert(threads).values({
      rootThreadId: THREAD_ID,
      id: THREAD_ID,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      title: "Thread",
      kind: "primary",
      aiWriteMode: "draft",
    });
    await db.insert(turns).values([
      {
        id: TURN_ID as never,
        threadId: THREAD_ID as never,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      },
      {
        id: TURN_2_ID as never,
        threadId: THREAD_ID as never,
        position: 2,
        parentTurnId: TURN_ID as never,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      },
      {
        id: TURN_3_ID as never,
        threadId: THREAD_ID as never,
        position: 3,
        parentTurnId: TURN_2_ID as never,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      },
    ]);
    await db
      .insert(threadWorks)
      .values({ threadId: THREAD_ID, workId: WORK_ID, projectId: PROJECT_ID, isPrimary: true });
  }

  return { createTestCollab, reset, dispose };
}
