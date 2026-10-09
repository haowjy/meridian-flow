/** Shared persisted Work draft fixture for collab operation integration tests. */
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentBranches,
  documents,
  projects,
  threads,
  threadWorks,
  turns,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import {
  DOCUMENT_RUNTIME_RESET_TABLES,
  deleteDrizzleRows,
} from "../../../test-support/drizzle-reset.js";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";

import { createAllowAllFileAccess } from "../../file-policy/index.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../../projects/index.js";
import { UNSUPPORTED_AHEAD_REFS } from "../adapters/in-memory/static-document-link-scopes.js";
import { createCollabDomain } from "../composition.js";
import {
  createTestDocumentLinkScopes,
  lateBoundManifestMembership,
} from "./document-link-scopes.js";

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

export const DRAFT_DESTINATION = { kind: "draft", workId: WORK_ID, workSlug: "work" } as const;

export function createWorkDraftFixture(db: Database) {
  const hocuspocus = fakeHocuspocus();
  const collabs: Array<{ dispose(): void }> = [];
  /** Without `links`, scopes read the created domain's own manifests, as production does. */
  const createTestCollab = (links?: ReturnType<typeof createTestDocumentLinkScopes>) => {
    const manifest = lateBoundManifestMembership();
    const collab = createCollabDomain({
      links: links ?? createTestDocumentLinkScopes(db, { membership: manifest.membership }),
      aheadRefs: UNSUPPORTED_AHEAD_REFS,
      fileAccess: createAllowAllFileAccess(),
      db,
      workProjectionMutation: createTestWorkProjectionMutation(db),
      workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
    });
    manifest.bind(collab);
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
      slug: "work",
      aiWriteMode: "draft",
    });
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
      extension: "md",
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
    const [draft] = await db
      .select({ id: documentBranches.id })
      .from(documentBranches)
      .where(
        and(
          eq(documentBranches.documentId, documentId as never),
          eq(documentBranches.kind, "work_draft"),
          eq(documentBranches.status, "active"),
        ),
      );
    if (!draft) throw new Error(`missing Work draft for ${documentId}`);
    await collab.pushToLive({ branchId: draft.id, pushedByUserId: USER_ID as never });
  }

  async function currentDraftId(
    collab: ReturnType<typeof createTestCollab>,
    documentId: string,
  ): Promise<string> {
    const drafts = await collab.draftReview.list({
      projectId: PROJECT_ID as never,
      workId: WORK_ID as never,
    });
    const draft = drafts.find((candidate) => candidate.documentId === documentId);
    if (!draft) throw new Error(`missing reviewable draft for ${documentId}`);
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
