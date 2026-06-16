/**
 * Collab document sync helper tests: provenance → facade routing and thread
 * activity scope for human writes.
 */
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryDocumentStore } from "../../collab/adapters/in-memory/document-store.js";
import { createDocumentSyncService } from "../../collab/domain/document-sync-service.js";
import {
  type ContextCollabDocumentSync,
  editCollabMarkdown,
  writeCollabMarkdown,
} from "./collab-document-sync.js";

const DOC = "00000000-0000-4000-8000-000000000101";
const THREAD = "00000000-0000-4000-8000-000000000202" as ThreadId;
const USER = "00000000-0000-4000-8000-000000000303" as UserId;

describe("collab-document-sync", () => {
  it("passes human threadId through writeDocument for thread-scoped activity", async () => {
    const inner = createDocumentSyncService(createInMemoryDocumentStore());
    const writeDocument = vi.fn(async () => ({
      documentId: DOC,
      markdown: "updated",
      updateSeq: 7,
      updateData: Buffer.alloc(0),
      originType: "user" as const,
      actorTurnId: null,
      actorUserId: USER,
    }));

    const documentSync = Object.assign(inner, { writeDocument }) as ContextCollabDocumentSync;

    const result = await writeCollabMarkdown({
      documentSync,
      documentId: DOC,
      seedMarkdown: "",
      filetype: "markdown",
      content: "updated",
      provenance: { type: "human", userId: USER, threadId: THREAD },
    });

    expect(result).toEqual({ ok: true, markdown: "updated", updateSeq: 7 });
    expect(writeDocument).toHaveBeenCalledWith({
      documentId: DOC,
      markdown: "updated",
      origin: { type: "user", actorUserId: USER },
      threadId: THREAD,
    });
  });

  it("routes agent edits through editDocument instead of read/write", async () => {
    const inner = createDocumentSyncService(createInMemoryDocumentStore());
    await inner.getOrCreateMirror(DOC, "hello", "markdown");

    const editDocument = vi.fn(async (input: { transform: (markdown: string) => string }) => ({
      documentId: DOC,
      beforeMarkdown: "hello",
      markdown: input.transform("hello"),
      updateSeq: 3,
      updateData: Buffer.alloc(0),
      originType: "agent" as const,
      actorTurnId: "00000000-0000-4000-8000-000000000404",
      actorUserId: null,
    }));

    const documentSync = Object.assign(inner, { editDocument }) as ContextCollabDocumentSync;

    const result = await editCollabMarkdown({
      documentSync,
      documentId: DOC,
      seedMarkdown: "hello",
      filetype: "markdown",
      transform: (content) => `${content}!`,
      provenance: {
        type: "agent",
        agentSlug: "writer",
        threadId: THREAD,
        turnId: "00000000-0000-4000-8000-000000000404",
      },
    });

    expect(result).toEqual({ ok: true, markdown: "hello!", updateSeq: 3 });
    expect(editDocument).toHaveBeenCalledTimes(1);
  });
});
