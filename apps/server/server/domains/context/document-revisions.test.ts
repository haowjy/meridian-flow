/** Document revisions resolve each document in the version the thread's writes change (D14, D20). */
import { describe, expect, it, vi } from "vitest";
import { createDocumentRevisions } from "./document-revisions.js";

const THREAD_ID = "thread-1";
const URIS: Record<string, string> = {
  chapter: "manuscript://ch1.md",
  lore: "kb://lore.md",
  notes: "scratch://@arc/notes.md",
};

function revisionsFor(aiWriteMode: "direct" | "draft", members: string[] = Object.keys(URIS)) {
  const readEffectiveRevision = vi.fn(
    async (input: { documentId: string; threadId?: string | null; destination: string }) =>
      `rev:${input.documentId}`,
  );
  const resolveManifestMembership = vi.fn(async () => ({ documentId: "manifest", members }));
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
  return { revisions, readEffectiveRevision, resolveManifestMembership };
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

  it("hides a drafted document the Work's draft manifest removed", async () => {
    const { revisions } = revisionsFor("draft", ["chapter", "notes"]);
    const current = await revisions.current({
      threadId: THREAD_ID,
      documentIds: ["lore", "notes"],
    });
    expect(current).toEqual(
      new Map([
        ["lore", null],
        ["notes", "rev:notes"],
      ]),
    );
  });

  it("reads everything live outside draft mode, without the draft manifest", async () => {
    const { revisions, readEffectiveRevision, resolveManifestMembership } = revisionsFor("direct");
    await revisions.current({ threadId: THREAD_ID, documentIds: ["chapter", "lore"] });

    expect(resolveManifestMembership).not.toHaveBeenCalled();
    expect(readEffectiveRevision.mock.calls.map(([input]) => input.destination)).toEqual([
      "live",
      "live",
    ]);
  });
});
