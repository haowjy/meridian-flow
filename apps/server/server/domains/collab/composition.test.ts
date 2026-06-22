/** Tests for the collab facade document-write post-hook. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventSink, type EventSink } from "../observability/index.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
} from "./adapters/in-memory/agent-edit.js";
import { type CollabFacadeStore, createFacade } from "./composition.js";
import type { CollabDomain, DocumentWriteHook } from "./index.js";

const DOC_ID = "00000000-0000-4000-8000-000000000301" as DocumentId;
const THREAD_ID = "00000000-0000-4000-8000-000000000302" as ThreadId;
const USER_ID = "00000000-0000-4000-8000-000000000303" as UserId;
const TURN_ID = "00000000-0000-4000-8000-000000000304" as TurnId;

type TestFacadeOptions = {
  hook?: DocumentWriteHook;
  eventSink?: EventSink;
};

describe("createFacade document write hook", () => {
  it("fires once after writeDocument with the resulting markdown and thread", async () => {
    const hook = vi.fn<DocumentWriteHook>(async () => undefined);
    const domain = createTestFacade({ hook });

    const result = await domain.writeDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: "Alpha draft.",
      origin: { type: "user", actorUserId: USER_ID },
    });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: result.markdown,
      at: expect.any(Date),
    });
  });

  it("fires once after editDocument with the edited full-document markdown", async () => {
    const hook = vi.fn<DocumentWriteHook>(async () => undefined);
    const domain = createTestFacade({ hook });
    const initial = await domain.writeDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: "Alpha draft.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    hook.mockClear();

    const result = await domain.editDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      transform: (markdown) => `${markdown}\n\nBeta revision.`,
      origin: { type: "agent", actorTurnId: TURN_ID },
    });

    expect(result.beforeMarkdown).toBe(initial.markdown);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: result.markdown,
      at: expect.any(Date),
    });
  });

  it("fires once after writeFromMarkdown without inventing a thread", async () => {
    const hook = vi.fn<DocumentWriteHook>(async () => undefined);
    const domain = createTestFacade({ hook });

    const write = await domain.writeFromMarkdown(DOC_ID, "Imported chapter.", {
      type: "import",
      userId: USER_ID,
      source: "upload",
      filename: "chapter.md",
    });
    const read = await domain.readAsMarkdown(DOC_ID);

    expect(write.ok).toBe(true);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("expected markdown read to succeed");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      documentId: DOC_ID,
      threadId: undefined,
      markdown: read.value,
      at: expect.any(Date),
    });
  });

  it("does not fire on readAsMarkdown", async () => {
    const hook = vi.fn<DocumentWriteHook>(async () => undefined);
    const domain = createTestFacade({ hook });
    await domain.writeDocument({
      documentId: DOC_ID,
      markdown: "Readable chapter.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    hook.mockClear();

    const read = await domain.readAsMarkdown(DOC_ID);

    expect(read.ok).toBe(true);
    expect(hook).not.toHaveBeenCalled();
  });

  it("emits hook failures without failing the committed write", async () => {
    const eventSink = createInMemoryEventSink();
    const hook = vi.fn<DocumentWriteHook>(async () => {
      throw new Error("projection database unavailable");
    });
    const domain = createTestFacade({ hook, eventSink });

    const result = await domain.writeDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: "Committed despite hook failure.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    const read = await domain.readAsMarkdown(DOC_ID);

    expect(result.markdown).toContain("Committed despite hook failure.");
    expect(read).toMatchObject({ ok: true, value: result.markdown });
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "collab.document_write",
        name: "post_write_hook.failed",
        payload: expect.objectContaining({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          name: "Error",
          message: "projection database unavailable",
        }),
      }),
    );
  });
});

function createTestFacade(options: TestFacadeOptions = {}): CollabDomain {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  return createFacade({
    journal,
    coordinator,
    lifecycle: createInMemoryDocumentLifecycle(coordinator),
    store: storeFor(journal),
    hocuspocus: () => null,
    bindHocuspocus: (_instance: Hocuspocus) => {},
    eventSink: options.eventSink,
    documentWriteHook: options.hook,
  });
}

function storeFor(journal: ReturnType<typeof createInMemoryJournal>): CollabFacadeStore {
  return {
    createCheckpoint: (docId, state, reason) => journal.createCheckpoint(docId, state, reason),
    getCheckpoint: (id) => journal.getCheckpoint(id),
    listCheckpoints: (docId) => journal.listCheckpoints(docId),
    latestUpdate: (docId) => journal.latestUpdate(docId),
  };
}
