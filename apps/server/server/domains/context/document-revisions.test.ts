/**
 * Document revisions keep scratch live in a draft-mode Work (D9, D14). The
 * Postgres suite in collab/document-revisions.db.test.ts covers the rest.
 */
import { describe, expect, it, vi } from "vitest";
import { createDocumentRevisions } from "./document-revisions.js";

const THREAD_ID = "thread-1";
const URIS: Record<string, string> = {
  chapter: "manuscript://ch1.md",
  lore: "kb://lore.md",
  notes: "scratch://@arc/notes.md",
};

function revisionsFor(aiWriteMode: "direct" | "draft") {
  const readEffectiveRevision = vi.fn(
    async (input: { documentId: string; threadId?: string | null; destination: string }) =>
      `rev:${input.documentId}`,
  );
  const resolveManifestMembership = async () => ({
    documentId: "manifest",
    members: Object.keys(URIS),
  });
  const revisions = createDocumentRevisions({
    documents: { readEffectiveRevision, resolveManifestMembership } as never,
    threads: {
      findById: async () => ({
        id: THREAD_ID,
        projectId: "project-1",
        userId: "user-1",
        deletedAt: null,
      }),
    } as never,
    threadWorks: { findPrimary: async () => ({ workId: "work-1" }) } as never,
    works: {
      findById: async () => ({ id: "work-1", slug: "arc", aiWriteMode, deletedAt: null }),
    } as never,
    availability: {
      lookup: async ({ documentIds }: { documentIds: string[] }) => ({
        resolutions: documentIds.map((documentId) => ({
          kind: "available",
          documentId,
          entry: { uri: URIS[documentId] },
        })),
      }),
    } as never,
  });
  return { revisions, readEffectiveRevision };
}

describe("document revisions", () => {
  it("reads drafted sources from the thread's draft and scratch live in draft mode", async () => {
    const { revisions, readEffectiveRevision } = revisionsFor("draft");
    await revisions.current({ threadId: THREAD_ID, documentIds: ["chapter", "lore", "notes"] });

    expect(readEffectiveRevision.mock.calls.map(([input]) => input)).toEqual([
      { documentId: "chapter", threadId: THREAD_ID, destination: "draft" },
      { documentId: "lore", threadId: THREAD_ID, destination: "draft" },
      { documentId: "notes", threadId: null, destination: "live" },
    ]);
  });
});
