/** ContextFS agent effective-view contracts for manuscript membership and grep/read bytes. */
import { describe, expect, it } from "vitest";
import type { Result } from "../../../../shared/result.js";
import { Ok } from "../../../../shared/result.js";
import type { SyncError } from "../../../collab/index.js";
import { ContextFS } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

const SOURCE_ID = "00000000-0000-4000-8000-000000000801";
const PROJECT_ID = "00000000-0000-4000-8000-000000000802";
const WORK_ID = "00000000-0000-4000-8000-000000000803";
const THREAD_ID = "00000000-0000-4000-8000-000000000804";
const LIVE_DOC_ID = "00000000-0000-4000-8000-000000000805";
const BRANCH_DOC_ID = "00000000-0000-4000-8000-000000000806";
const CREATED_DOC_ID = "00000000-0000-4000-8000-000000000807";

function okMarkdown(value: string): Result<string, SyncError> {
  return Ok(value);
}

describe("ContextFS manuscript effective view", () => {
  it("lists and greps the resolved manifest branch, not the SQL document set", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    await store.upsertDocument({
      id: LIVE_DOC_ID,
      folderId: null,
      name: "live-only",
      extension: "md",
      markdown: "SQL row that the draft manifest deleted",
      filetype: "markdown",
    });
    await store.upsertDocument({
      id: CREATED_DOC_ID,
      folderId: null,
      name: "draft-created",
      extension: "md",
      markdown: "SQL identity row for a draft-created document",
      filetype: "markdown",
    });

    const fs = new ContextFS({
      store,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      scheme: "manuscript",
      manifestView: { projectId: PROJECT_ID, workId: WORK_ID, threadId: THREAD_ID },
      documentSync: {
        ensureDocument: async () => {},
        readAsMarkdown: async () => okMarkdown("live projection must not be read"),
        readEffectiveMarkdown: async ({ documentId }: { documentId: string }) =>
          okMarkdown(documentId === CREATED_DOC_ID ? "new branch bytes" : "unexpected"),
        readEffectiveHashlines: async ({ documentId }: { documentId: string }) =>
          Ok([documentId === CREATED_DOC_ID ? "createdhash|new branch bytes" : "unexpected"]),
        resolveManifestMembership: async () => ({
          documentId: "manifest-doc",
          members: [CREATED_DOC_ID],
        }),
        seedFromMarkdown: async () => Ok(null),
        writeDocument: async () => {
          throw new Error("not used");
        },
        editDocument: async () => {
          throw new Error("not used");
        },
      } as never,
    });

    const listed = await fs.list("");
    expect(listed.ok ? listed.value : []).toEqual([
      expect.objectContaining({ documentId: CREATED_DOC_ID, path: "draft-created.md" }),
    ]);
    const hits = await fs.search("branch");
    expect(hits.ok ? hits.value : []).toEqual([
      expect.objectContaining({
        path: "draft-created.md",
        excerpt: "createdhash|new branch bytes",
      }),
    ]);
  });

  it("keeps grep excerpts byte-equal to readEffectiveMarkdown for branch-touched and draft-created docs", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    await store.upsertDocument({
      id: BRANCH_DOC_ID,
      folderId: null,
      name: "branch-touched",
      extension: "md",
      markdown: "live old bytes",
      filetype: "markdown",
    });
    await store.upsertDocument({
      id: CREATED_DOC_ID,
      folderId: null,
      name: "draft-created",
      extension: "md",
      markdown: "identity only",
      filetype: "markdown",
    });
    const effective = new Map([
      [BRANCH_DOC_ID, "branchhash|branch touched needle bytes"],
      [CREATED_DOC_ID, "createdhash|draft created needle bytes"],
    ]);
    const fs = new ContextFS({
      store,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      scheme: "manuscript",
      manifestView: { projectId: PROJECT_ID, workId: WORK_ID, threadId: THREAD_ID },
      documentSync: {
        ensureDocument: async () => {},
        readAsMarkdown: async () => okMarkdown("live projection must not be read"),
        readEffectiveMarkdown: async ({ documentId }: { documentId: string }) =>
          okMarkdown(effective.get(documentId) ?? ""),
        readEffectiveHashlines: async ({ documentId }: { documentId: string }) =>
          Ok([effective.get(documentId) ?? ""]),
        resolveManifestMembership: async () => ({
          documentId: "manifest-doc",
          members: [BRANCH_DOC_ID, CREATED_DOC_ID],
        }),
        seedFromMarkdown: async () => Ok(null),
        writeDocument: async () => {
          throw new Error("not used");
        },
        editDocument: async () => {
          throw new Error("not used");
        },
      } as never,
    });

    const hits = await fs.search("needle");
    expect(hits.ok ? hits.value : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "branch-touched.md",
          excerpt: effective.get(BRANCH_DOC_ID),
        }),
        expect.objectContaining({
          path: "draft-created.md",
          excerpt: effective.get(CREATED_DOC_ID),
        }),
      ]),
    );
    await expect(fs.read("branch-touched.md")).resolves.toEqual(
      Ok({ content: effective.get(BRANCH_DOC_ID) ?? "", documentId: BRANCH_DOC_ID }),
    );
    await expect(fs.read("draft-created.md")).resolves.toEqual(
      Ok({ content: effective.get(CREATED_DOC_ID) ?? "", documentId: CREATED_DOC_ID }),
    );
  });

  it("lists without manifest filtering when membership resolution is not ready yet", async () => {
    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
    await store.upsertDocument({
      id: LIVE_DOC_ID,
      folderId: null,
      name: "chapter-1",
      extension: "md",
      markdown: "seed",
      filetype: "markdown",
    });

    const fs = new ContextFS({
      store,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      scheme: "manuscript",
      manifestView: { projectId: PROJECT_ID },
      documentSync: {
        ensureDocument: async () => {},
        readAsMarkdown: async () => okMarkdown("live"),
        resolveManifestMembership: async () => {
          throw new Error("Project has no context source for a manifest identity");
        },
      } as never,
    });

    const listed = await fs.list("");
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value).toEqual([
        expect.objectContaining({ documentId: LIVE_DOC_ID, path: "chapter-1.md" }),
      ]);
    }
  });
});
