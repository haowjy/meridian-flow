/** Shared persisted Work branch fixture for collab operation integration tests. */
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  contextSources,
  documents,
  projects,
  threads,
  threadWorks,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import * as Y from "yjs";
import { createTestRemovalDeps } from "../../../test-support/document-removal.js";
import {
  DOCUMENT_RUNTIME_RESET_TABLES,
  deleteDrizzleRows,
} from "../../../test-support/drizzle-reset.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createDrizzleContextCatalog } from "../../context/adapters/context-catalog.js";
import { createAllowAllFileAccess } from "../../file-policy/index.js";
import { UNSUPPORTED_AHEAD_REFS } from "../adapters/in-memory/static-document-link-scopes.js";
import { createCollabDomain } from "../composition.js";
import { applyDraftDocument } from "./apply-draft-document.js";
import { convergedReview } from "./converged-review.js";
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

export const DRAFT_DESTINATION = { kind: "draft", workId: WORK_ID, workHandle: "work" } as const;

export function createWorkBranchFixture(db: Database) {
  const hocuspocus = fakeHocuspocus();
  const collabs: Array<{ dispose(): void }> = [];
  /** Without custom links, use the real tree-backed scope, as production does. */
  const createTestCollab = (links?: ReturnType<typeof createTestDocumentLinkScopes>) => {
    const collab = convergedReview(
      createCollabDomain({
        links: links ?? createTestDocumentLinkScopes(db),
        aheadRefs: UNSUPPORTED_AHEAD_REFS,
        fileAccess: createAllowAllFileAccess(),
        db,
        workProjectionMutation: createTestWorkProjectionMutation(db),
        catalogMutations: createDrizzleContextCatalog(db),
        ...createTestRemovalDeps(db),
      }),
    );
    collabs.push(collab);
    return collab;
  };

  const dispose = () => {
    for (const collab of collabs.splice(0)) collab.dispose();
  };

  async function reset() {
    hocuspocus.documents.clear();
    await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
    await db.insert(users).values(conformanceUserValues(USER_ID, "collab-reverse"));
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, userId: USER_ID, name: "Project", slug: "project" });
    await db.insert(works).values({
      id: WORK_ID,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      name: "Work",
      handle: "w1",
    });
    // The Work already has its branch, as if an earlier write ensured it (contract §2.5).
    await db
      .insert(branches)
      .values({ projectId: PROJECT_ID, originWorkId: WORK_ID, createdBy: USER_ID });
    await db.insert(contextSources).values({
      id: SOURCE_ID,
      projectId: PROJECT_ID,
      name: "Manuscript",
      slug: "manuscript",
      scope: "project",
      isPrimary: true,
    });
    await db.insert(documents).values({
      id: DOC_ID,
      contextSourceId: SOURCE_ID,
      name: "chapter",
      extension: "",
      fileType: "markdown",
    });
    await db.insert(threads).values({
      rootThreadId: THREAD_ID,
      id: THREAD_ID,
      projectId: PROJECT_ID,
      createdByUserId: USER_ID,
      title: "Thread",
      kind: "primary",
      status: "idle",
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
  /** The writer applies the document's Work draft (a draft write never pushes itself, D59). */
  async function applyDraft(
    collab: ReturnType<typeof createTestCollab>,
    documentId: string,
  ): Promise<void> {
    await applyDraftDocument(collab.draftReview, {
      workId: WORK_ID as never,
      documentId: documentId as never,
      userId: USER_ID as never,
    });
  }

  async function currentDraftId(
    collab: ReturnType<typeof createTestCollab>,
    documentId: string,
  ): Promise<string> {
    const draft = await collab.draftReview.resolveItemByDocument({
      workId: WORK_ID as never,
      documentId: documentId as never,
    });
    if (!draft?.draftId) throw new Error(`missing reviewable draft for ${documentId}`);
    return draft.draftId;
  }

  return { hocuspocus, createTestCollab, reset, dispose, applyDraft, currentDraftId };
}

function fakeHocuspocus() {
  const documents = new Map<string, Y.Doc>();
  return {
    documents,
    async openDirectConnection(documentName: string) {
      let document = documents.get(documentName);
      if (!document) {
        document = new Y.Doc({ gc: false });
        documents.set(documentName, document);
      }
      return { document, disconnect: async () => undefined };
    },
  };
}
