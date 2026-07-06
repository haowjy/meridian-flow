/** Tests for the collab facade document-write post-hook. */
import type { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { AGENT_EDIT_UNDO_CLIENT_ID, RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ContextFS } from "../context/adapters/context-fs/context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "../context/adapters/context-fs/in-memory-store.js";
import { createInMemoryEventSink, type EventSink } from "../observability/index.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
} from "./adapters/in-memory/agent-edit.js";
import {
  createInMemoryDraftAcceptJournal,
  createInMemoryDraftStore,
} from "./adapters/in-memory/drafts.js";
import {
  type CollabFacadeStore,
  createFacade,
  createThreadPeerAgentEditCore,
} from "./composition.js";
import { BranchNotFoundError } from "./domain/branch-resolver.js";
import type { CollabDomain, DocumentWriteHook } from "./index.js";

const DOC_ID = "00000000-0000-4000-8000-000000000301" as DocumentId;
const OTHER_DOC_ID = "00000000-0000-4000-8000-000000000305" as DocumentId;
const THREAD_ID = "00000000-0000-4000-8000-000000000302" as ThreadId;
const OTHER_THREAD_ID = "00000000-0000-4000-8000-000000000307" as ThreadId;
const USER_ID = "00000000-0000-4000-8000-000000000303" as UserId;
const WORK_ID = "00000000-0000-4000-8000-000000000306" as never;
const TURN_ID = "00000000-0000-4000-8000-000000000304" as TurnId;

type TestFacadeOptions = {
  hook?: DocumentWriteHook;
  eventSink?: EventSink;
  aiWriteMode?: "direct" | "draft";
  branchStore?: unknown;
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

describe("draft accept reversal guard", () => {
  it("treats delete-only Yjs updates as effective document changes", () => {
    const doc = new Y.Doc({ gc: false });
    const text = doc.getText("body");
    text.insert(0, "accepted draft text");

    const beforeVector = Y.encodeStateVector(doc);
    const beforeDocumentState = Y.encodeStateAsUpdate(doc);
    text.delete(0, text.length);

    const afterVector = Y.encodeStateVector(doc);
    expect(afterVector).toEqual(beforeVector);

    const stateVectorGuardSawChange = !bytesEqual(beforeVector, afterVector);
    const documentStateGuardSawChange = !bytesEqual(
      beforeDocumentState,
      Y.encodeStateAsUpdate(doc),
    );
    expect(stateVectorGuardSawChange).toBe(false);
    expect(documentStateGuardSawChange).toBe(true);
  });
});

describe("draftReview draft-id facade validation", () => {
  it("treats a non-active draft-id preview as gone", async () => {
    const { domain, draftStore } = createTestHarness();
    await domain.writeDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: "Live manuscript.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    const draft = await draftStore.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_ID,
    });
    await draftStore.reject({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id });

    await expect(
      domain.draftReview.preview({ documentId: DOC_ID, draftId: draft.id }),
    ).resolves.toEqual({
      status: "gone",
      live: expect.stringContaining("Live manuscript."),
    });
  });

  it("treats a draft-id preview for another document as gone", async () => {
    const { domain, draftStore } = createTestHarness();
    await domain.writeDocument({
      documentId: OTHER_DOC_ID,
      threadId: THREAD_ID,
      markdown: "Other live manuscript.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    const draft = await draftStore.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_ID,
    });

    await expect(
      domain.draftReview.preview({ documentId: OTHER_DOC_ID, draftId: draft.id }),
    ).resolves.toEqual({
      status: "gone",
      live: expect.stringContaining("Other live manuscript."),
    });
  });

  it("does not expose journals through non-active or cross-document draft ids", async () => {
    const { domain, draftStore } = createTestHarness();
    const discarded = await draftStore.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_ID,
    });
    await draftStore.reject({ documentId: DOC_ID, threadId: THREAD_ID, draftId: discarded.id });
    const active = await draftStore.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_ID,
    });

    await expect(
      domain.draftReview.journal({ documentId: DOC_ID, draftId: discarded.id }),
    ).resolves.toEqual({
      status: "not_found",
    });
    await expect(
      domain.draftReview.journal({ documentId: OTHER_DOC_ID, draftId: active.id }),
    ).resolves.toEqual({ status: "not_found" });
  });
});

describe("thread-peer agent tool boundary", () => {
  it("pulls the thread peer before the real AgentEdit.write tool interaction", async () => {
    const beforeThreadInteraction = vi.fn(async () => undefined);
    const threadWrite = vi.fn(async () => ({
      command: "insert",
      status: "success",
      isError: false,
      text: "status: success",
    }));
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      createThreadCore: () =>
        ({ ...(fakeAgentCore() as Record<string, unknown>), write: threadWrite }) as never,
      beforeThreadInteraction,
    });

    await core.write(
      { command: "insert", documentId: DOC_ID, file: "chapter.md", content: "A writes." },
      { threadId: THREAD_ID, turnId: TURN_ID },
    );

    expect(beforeThreadInteraction).toHaveBeenCalledWith({
      documentId: DOC_ID,
      threadId: THREAD_ID,
    });
    expect(threadWrite).toHaveBeenCalledTimes(1);
  });

  it("retains a pulled interaction baseline across a failed write and clears it after success", async () => {
    const pulledBaseline = new Uint8Array([1, 2, 3]);
    const beforeThreadInteraction = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: pulledBaseline })
      .mockResolvedValue({ changed: false });
    const threadWrite = vi
      .fn()
      .mockResolvedValueOnce({
        command: "replace",
        status: "internal_error",
        isError: true,
        text: "status: internal_error",
      })
      .mockResolvedValue({
        command: "replace",
        status: "success",
        isError: false,
        text: "status: success",
      });
    const invalidateThread = vi.fn();
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      createThreadCore: () =>
        ({
          ...(fakeAgentCore() as Record<string, unknown>),
          write: threadWrite,
          invalidateThread,
        }) as never,
      beforeThreadInteraction,
    });

    const command = {
      command: "replace" as const,
      documentId: DOC_ID,
      file: "chapter.md",
      find: "old",
      content: "new",
    };

    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });

    expect(threadWrite).toHaveBeenCalledTimes(3);
    expect(threadWrite.mock.calls[0]?.[1].interactionContext?.baselineSnapshot).toBe(
      pulledBaseline,
    );
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.baselineSnapshot).toBe(
      pulledBaseline,
    );
    expect(threadWrite.mock.calls[2]?.[1].interactionContext?.baselineSnapshot).toBeUndefined();
    expect(invalidateThread).toHaveBeenCalledTimes(2);
  });

  it("discards only reset-invalidated thread-peer branches and not plain failed writes", async () => {
    const discardThreadPeerBranches = vi.fn(async () => undefined);
    const writesByThread = new Map<string, ReturnType<typeof vi.fn>>();
    const invalidatesByThread = new Map<string, ReturnType<typeof vi.fn>>();
    const beforeThreadInteraction = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: new Uint8Array([1]) })
      .mockResolvedValue({ changed: false });
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      discardThreadPeerBranches,
      createThreadCore: (threadId) => {
        const write = vi.fn(async () => ({
          command: "replace",
          status: threadId === THREAD_ID ? "internal_error" : "success",
          isError: threadId === THREAD_ID,
          text: "status",
        }));
        const invalidateThread = vi.fn(async () => undefined);
        writesByThread.set(threadId, write);
        invalidatesByThread.set(threadId, invalidateThread);
        return {
          ...(fakeAgentCore() as Record<string, unknown>),
          write,
          invalidateThread,
        } as never;
      },
      beforeThreadInteraction,
    });

    await core.write(
      { command: "replace", documentId: DOC_ID, file: "chapter.md", find: "old", content: "new" },
      { threadId: THREAD_ID, turnId: TURN_ID },
    );
    await core.write(
      { command: "replace", documentId: DOC_ID, file: "chapter.md", find: "old", content: "new" },
      { threadId: OTHER_THREAD_ID, turnId: TURN_ID, responseId: "response-other" },
    );

    expect(discardThreadPeerBranches).not.toHaveBeenCalled();

    await core.invalidateThread(DOC_ID, THREAD_ID);

    expect(discardThreadPeerBranches).toHaveBeenCalledExactlyOnceWith(DOC_ID, THREAD_ID);
    expect(invalidatesByThread.get(THREAD_ID)).toHaveBeenCalled();
    expect(invalidatesByThread.get(OTHER_THREAD_ID)).not.toHaveBeenCalled();
  });

  it("clears a failed-write pending baseline when the thread is reset", async () => {
    const staleBaseline = new Uint8Array([1, 2, 3]);
    const freshBaseline = new Uint8Array([4, 5, 6]);
    const beforeThreadInteraction = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: staleBaseline })
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: freshBaseline });
    const threadWrite = vi
      .fn()
      .mockResolvedValueOnce({
        command: "replace",
        status: "internal_error",
        isError: true,
        text: "status: internal_error",
      })
      .mockResolvedValueOnce({
        command: "replace",
        status: "success",
        isError: false,
        text: "status: success",
      });
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      createThreadCore: () =>
        ({
          ...(fakeAgentCore() as Record<string, unknown>),
          write: threadWrite,
        }) as never,
      beforeThreadInteraction,
    });
    const command = {
      command: "replace" as const,
      documentId: DOC_ID,
      file: "chapter.md",
      find: "old",
      content: "new",
    };

    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.invalidateThread(DOC_ID, THREAD_ID);
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });

    expect(threadWrite.mock.calls[0]?.[1].interactionContext?.baselineSnapshot).toBe(staleBaseline);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.baselineSnapshot).toBe(freshBaseline);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.baselineSnapshot).not.toBe(
      staleBaseline,
    );
  });

  it("clears pending baselines when evicting an idle thread core", async () => {
    const staleBaseline = new Uint8Array([1, 2, 3]);
    const freshBaseline = new Uint8Array([4, 5, 6]);
    const beforeThreadInteraction = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: staleBaseline })
      .mockResolvedValueOnce({ changed: false })
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: freshBaseline });
    const writesByThread = new Map<string, ReturnType<typeof vi.fn>>();
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      maxThreadCores: 1,
      createThreadCore: (threadId) => {
        const write = vi
          .fn()
          .mockResolvedValueOnce({
            command: "replace",
            status: threadId === THREAD_ID ? "internal_error" : "success",
            isError: threadId === THREAD_ID,
            text: "status",
          })
          .mockResolvedValue({
            command: "replace",
            status: "success",
            isError: false,
            text: "status: success",
          });
        writesByThread.set(threadId, write);
        return { ...(fakeAgentCore() as Record<string, unknown>), write } as never;
      },
      beforeThreadInteraction,
    });
    const command = {
      command: "replace" as const,
      documentId: DOC_ID,
      file: "chapter.md",
      find: "old",
      content: "new",
    };

    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    const firstThreadWrite = writesByThread.get(THREAD_ID);
    await core.write(command, { threadId: OTHER_THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    const recreatedThreadWrite = writesByThread.get(THREAD_ID);

    expect(firstThreadWrite?.mock.calls[0]?.[1].interactionContext?.baselineSnapshot).toBe(
      staleBaseline,
    );
    expect(recreatedThreadWrite).not.toBe(firstThreadWrite);
    expect(recreatedThreadWrite?.mock.calls[0]?.[1].interactionContext?.baselineSnapshot).toBe(
      freshBaseline,
    );
  });

  it("pairs a retained pending baseline with its captured journal floor", async () => {
    const firstBaseline = new Uint8Array([1, 2, 3]);
    const retryBaseline = new Uint8Array([4, 5, 6]);
    const beforeThreadInteraction = vi
      .fn()
      .mockResolvedValueOnce({
        changed: true,
        baselineSnapshot: firstBaseline,
        afterJournalId: 7,
        branchGeneration: 1,
      })
      .mockResolvedValueOnce({
        changed: true,
        baselineSnapshot: retryBaseline,
        afterJournalId: 12,
        branchGeneration: 1,
      })
      .mockResolvedValueOnce({ changed: false, branchGeneration: 1 });
    const threadWrite = vi
      .fn()
      .mockResolvedValueOnce({
        command: "replace",
        status: "internal_error",
        isError: true,
        text: "status",
      })
      .mockResolvedValueOnce({
        command: "replace",
        status: "success",
        isError: false,
        text: "status",
      })
      .mockResolvedValueOnce({
        command: "replace",
        status: "success",
        isError: false,
        text: "status",
      });
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      createThreadCore: () =>
        ({ ...(fakeAgentCore() as Record<string, unknown>), write: threadWrite }) as never,
      beforeThreadInteraction,
    });
    const command = {
      command: "replace" as const,
      documentId: DOC_ID,
      file: "chapter.md",
      find: "old",
      content: "new",
    };

    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });

    expect(threadWrite.mock.calls[0]?.[1].interactionContext?.baselineSnapshot).toBe(firstBaseline);
    expect(threadWrite.mock.calls[0]?.[1].interactionContext?.afterJournalId).toBe(7);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.baselineSnapshot).toBe(firstBaseline);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.afterJournalId).toBe(7);
    expect(threadWrite.mock.calls[2]?.[1].interactionContext?.baselineSnapshot).toBeUndefined();
  });

  it("drops a retained pending baseline when the branch generation changes", async () => {
    const staleBaseline = new Uint8Array([1, 2, 3]);
    const freshBaseline = new Uint8Array([4, 5, 6]);
    const beforeThreadInteraction = vi
      .fn()
      .mockResolvedValueOnce({
        changed: true,
        baselineSnapshot: staleBaseline,
        branchGeneration: 1,
      })
      .mockResolvedValueOnce({
        changed: true,
        baselineSnapshot: freshBaseline,
        branchGeneration: 2,
      });
    const threadWrite = vi
      .fn()
      .mockResolvedValueOnce({
        command: "replace",
        status: "internal_error",
        isError: true,
        text: "status",
      })
      .mockResolvedValueOnce({
        command: "replace",
        status: "success",
        isError: false,
        text: "status",
      });
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      createThreadCore: () =>
        ({ ...(fakeAgentCore() as Record<string, unknown>), write: threadWrite }) as never,
      beforeThreadInteraction,
    });
    const command = {
      command: "replace" as const,
      documentId: DOC_ID,
      file: "chapter.md",
      find: "old",
      content: "new",
    };

    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });

    expect(threadWrite.mock.calls[0]?.[1].interactionContext?.baselineSnapshot).toBe(staleBaseline);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.baselineSnapshot).toBe(freshBaseline);
  });

  it("keeps the oldest pending baseline when a retry pull is also changed", async () => {
    const firstBaseline = new Uint8Array([1, 2, 3]);
    const retryBaseline = new Uint8Array([4, 5, 6]);
    const beforeThreadInteraction = vi
      .fn()
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: firstBaseline })
      .mockResolvedValueOnce({ changed: true, baselineSnapshot: retryBaseline })
      .mockResolvedValueOnce({ changed: false });
    const threadWrite = vi
      .fn()
      .mockResolvedValueOnce({
        command: "replace",
        status: "internal_error",
        isError: true,
        text: "status: internal_error",
      })
      .mockResolvedValueOnce({
        command: "replace",
        status: "success",
        isError: false,
        text: "status: success",
      })
      .mockResolvedValueOnce({
        command: "replace",
        status: "success",
        isError: false,
        text: "status: success",
      });
    const core = createThreadPeerAgentEditCore({
      liveUtilityCore: fakeAgentCore() as never,
      createThreadCore: () =>
        ({
          ...(fakeAgentCore() as Record<string, unknown>),
          write: threadWrite,
        }) as never,
      beforeThreadInteraction,
    });
    const command = {
      command: "replace" as const,
      documentId: DOC_ID,
      file: "chapter.md",
      find: "old",
      content: "new",
    };

    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });
    await core.write(command, { threadId: THREAD_ID, turnId: TURN_ID });

    expect(threadWrite.mock.calls[0]?.[1].interactionContext?.baselineSnapshot).toBe(firstBaseline);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.baselineSnapshot).toBe(firstBaseline);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.afterJournalId).toBe(0);
    expect(threadWrite.mock.calls[1]?.[1].interactionContext?.baselineSnapshot).not.toBe(
      retryBaseline,
    );
    expect(threadWrite.mock.calls[2]?.[1].interactionContext?.baselineSnapshot).toBeUndefined();
  });
});

describe("createFacade effective markdown chain", () => {
  it("falls back to live markdown for a fresh thread with no branch peers", async () => {
    const branchStore = {
      resolveThreadBranch: async (documentId: DocumentId, threadId: ThreadId) => {
        throw new BranchNotFoundError(documentId, threadId);
      },
      resolveWorkDraftBranchForThread: async (documentId: DocumentId, threadId: ThreadId) => {
        throw new BranchNotFoundError(documentId, threadId);
      },
    };
    const { domain } = createTestHarness({ branchStore });
    await domain.writeDocument({
      documentId: DOC_ID,
      markdown: "Needle live chapter.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    await domain.writeDocument({
      documentId: OTHER_DOC_ID,
      markdown: "Untouched live chapter.",
      origin: { type: "user", actorUserId: USER_ID },
    });

    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: "source-effective", backing });
    await store.upsertDocument({
      id: DOC_ID,
      folderId: null,
      name: "needle",
      extension: "md",
      markdown: "stale SQL projection",
      filetype: "markdown",
    });
    await store.upsertDocument({
      id: OTHER_DOC_ID,
      folderId: null,
      name: "untouched",
      extension: "md",
      markdown: "untouched SQL projection",
      filetype: "markdown",
    });
    const fs = new ContextFS({
      store,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      scheme: "manuscript",
      manifestView: { projectId: "project-1", workId: WORK_ID, threadId: THREAD_ID },
      documentSync: {
        ...domain,
        resolveManifestMembership: async () => ({
          documentId: "manifest-doc" as DocumentId,
          members: [DOC_ID, OTHER_DOC_ID],
        }),
      } as never,
    });

    await expect(
      domain.readEffectiveMarkdown({ documentId: DOC_ID, threadId: THREAD_ID }),
    ).resolves.toMatchObject({ ok: true, value: expect.stringContaining("Needle live chapter") });
    await expect(fs.read("needle.md")).resolves.toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("Needle live chapter"), documentId: DOC_ID },
    });
    await expect(fs.search("Untouched")).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ excerpt: expect.stringContaining("Untouched live") })],
    });
  });

  it("gates manuscript stat/read by the resolved manifest membership", async () => {
    const { domain } = createTestHarness();
    await domain.writeDocument({
      documentId: DOC_ID,
      markdown: "Visible live chapter.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    await domain.writeDocument({
      documentId: OTHER_DOC_ID,
      markdown: "Hidden live chapter.",
      origin: { type: "user", actorUserId: USER_ID },
    });

    const backing = createInMemoryContextDocumentStoreBacking();
    const store = new InMemoryContextDocumentStore({ sourceId: "source-membership", backing });
    await store.upsertDocument({
      id: DOC_ID,
      folderId: null,
      name: "visible",
      extension: "md",
      markdown: "visible projection",
      filetype: "markdown",
    });
    await store.upsertDocument({
      id: OTHER_DOC_ID,
      folderId: null,
      name: "hidden",
      extension: "md",
      markdown: "hidden projection",
      filetype: "markdown",
    });
    const fs = new ContextFS({
      store,
      mutationStore: new InMemoryContextTreeMutationStore(backing),
      scheme: "manuscript",
      manifestView: { projectId: "project-1", workId: WORK_ID, threadId: THREAD_ID },
      documentSync: {
        ...domain,
        resolveManifestMembership: async () => ({
          documentId: "manifest-doc" as DocumentId,
          members: [DOC_ID],
        }),
      } as never,
    });

    await expect(fs.stat("visible.md")).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ documentId: DOC_ID }),
    });
    await expect(fs.read("visible.md")).resolves.toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("Visible live chapter."), documentId: DOC_ID },
    });
    await expect(fs.stat("hidden.md")).resolves.toEqual({ ok: true, value: null });
    await expect(fs.read("hidden.md")).resolves.toEqual({ ok: true, value: null });
    await expect(fs.tree.inspectMovable("hidden.md")).resolves.toEqual({ ok: true, value: null });
  });
});

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

describe("createFacade response write finalization", () => {
  it("commits staged response writes and refreshes the live projection", async () => {
    const hook = vi.fn<DocumentWriteHook>(async () => undefined);
    const domain = createTestFacade({ hook });
    await domain.writeDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: "Alpha draft.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    hook.mockClear();
    await domain
      .agentEdit()
      .write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );

    const write = await domain
      .agentEdit()
      .write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Beta revision." },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-commit" },
      );
    expect(write.isError).toBe(false);

    const result = await domain.finalizeResponseCommit("response-commit", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const read = await domain.readAsMarkdown(DOC_ID);

    expect(result).toEqual({
      documents: [{ documentId: DOC_ID, updateCount: 1 }],
      stagedCreates: { committed: [], discarded: [] },
    });
    expect(read).toMatchObject({ ok: true, value: expect.stringContaining("Beta revision.") });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: expect.stringContaining("Beta revision."),
      at: expect.any(Date),
    });
  });

  it("rolls back staged response writes and returns staged-create outcomes", async () => {
    const domain = createTestFacade();
    const stagedDocumentId = "00000000-0000-4000-8000-000000000305" as DocumentId;

    const write = await domain.agentEdit().write(
      {
        command: "create",
        file: "new-chapter.md",
        documentId: stagedDocumentId,
        content: "Discarded draft.",
      },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId: "response-rollback",
        createdDocument: true,
      },
    );
    expect(write.isError).toBe(false);

    await expect(domain.finalizeResponseRollback("response-rollback")).resolves.toEqual({
      stagedCreates: { committed: [], discarded: [stagedDocumentId] },
    });
    await expect(domain.readAsMarkdown(stagedDocumentId)).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("logs finalization projection hook failures under the response-finalize source", async () => {
    const eventSink = createInMemoryEventSink();
    const hook = vi.fn<DocumentWriteHook>(async () => {
      throw new Error("projection database unavailable");
    });
    const domain = createTestFacade({ hook, eventSink });
    await domain.writeDocument({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      markdown: "Alpha draft.",
      origin: { type: "user", actorUserId: USER_ID },
    });
    eventSink.events.length = 0;
    await domain
      .agentEdit()
      .write(
        { command: "read", file: "chapter.md", documentId: DOC_ID },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );

    const write = await domain
      .agentEdit()
      .write(
        { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Beta revision." },
        { threadId: THREAD_ID, turnId: TURN_ID, responseId: "response-hook-failure" },
      );
    expect(write.isError).toBe(false);

    await expect(
      domain.finalizeResponseCommit("response-hook-failure", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).resolves.toMatchObject({
      documents: [{ documentId: DOC_ID, updateCount: 1 }],
    });
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "collab.response_finalize",
        name: "post_write_hook.failed",
        payload: expect.objectContaining({
          documentId: DOC_ID,
          threadId: THREAD_ID,
          message: "projection database unavailable",
        }),
      }),
    );
  });
});

describe("createFacade connection update ingest", () => {
  it.each([
    500,
    AGENT_EDIT_UNDO_CLIENT_ID,
  ])("rejects connection updates authored inside the reserved clientID band (%s)", async (reservedClientId) => {
    const eventSink = createInMemoryEventSink();
    const { domain, journal } = createTestHarness({ eventSink });
    const foreign = updateAuthoredBy(reservedClientId);

    domain.persistConnectionUpdate({
      documentId: DOC_ID,
      update: foreign.update,
      origin: { type: "user", userId: USER_ID },
      document: foreign.doc,
    });
    await domain.drainHocuspocusPersistence();
    await domain.storeHocuspocusDocument(DOC_ID, foreign.doc);

    expect((await journal.read(DOC_ID)).updates).toEqual([]);
    expect(await journal.listCheckpoints(DOC_ID)).toEqual([]);
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        source: "collab.agent_edit",
        name: "invariant_violation",
        payload: expect.objectContaining({
          documentId: DOC_ID,
          originType: "user",
          reservedClientId,
          reservedClientIdMax: RESERVED_CLIENT_ID_MAX,
        }),
      }),
    );
  });

  it("persists draft-room connection updates to the draft journal", async () => {
    const { domain, draftStore } = createTestHarness();
    const draft = await draftStore.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_ID,
    });
    const foreign = updateAuthoredBy(RESERVED_CLIENT_ID_MAX + 1);

    domain.persistDraftConnectionUpdate({
      draftId: draft.id,
      update: foreign.update,
      origin: { type: "user", userId: USER_ID },
      document: foreign.doc,
    });
    await domain.drainHocuspocusDraftPersistence(draft.id);

    const updates = await draftStore.listUpdates(draft.id);
    expect(updates).toHaveLength(1);
    expect([...(updates[0]?.updateData ?? [])]).toEqual([...foreign.update]);
    expect(updates[0]?.actorUserId).toBe(USER_ID);
    expect(updates[0]?.actorTurnId).toBeNull();
  });

  it("drops draft-room connection updates after finalization", async () => {
    const eventSink = createInMemoryEventSink();
    const { domain, draftStore } = createTestHarness({ eventSink });
    const draft = await draftStore.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_ID,
    });
    await draftStore.reject({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id });
    const foreign = updateAuthoredBy(RESERVED_CLIENT_ID_MAX + 1);

    domain.persistDraftConnectionUpdate({
      draftId: draft.id,
      update: foreign.update,
      origin: { type: "user", userId: USER_ID },
      document: foreign.doc,
    });
    await domain.drainHocuspocusDraftPersistence(draft.id);

    await expect(draftStore.listUpdates(draft.id)).resolves.toEqual([]);
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        source: "collab.hocuspocus",
        name: "draft_append.rejected",
        payload: expect.objectContaining({ draftId: draft.id }),
      }),
    );
  });

  it("persists normal connection updates unchanged", async () => {
    const eventSink = createInMemoryEventSink();
    const { domain, journal } = createTestHarness({ eventSink });
    const foreign = updateAuthoredBy(RESERVED_CLIENT_ID_MAX + 1);

    domain.persistConnectionUpdate({
      documentId: DOC_ID,
      update: foreign.update,
      origin: { type: "user", userId: USER_ID },
      document: foreign.doc,
    });
    await domain.drainHocuspocusPersistence();

    const snapshot = await journal.read(DOC_ID);
    expect(snapshot.updates).toHaveLength(1);
    expect(snapshot.updates[0]?.meta.origin).toBe(`human:${USER_ID}`);
    expect([...(snapshot.updates[0]?.update ?? [])]).toEqual([...foreign.update]);
    expect(eventSink.events).not.toContainEqual(
      expect.objectContaining({
        source: "collab.agent_edit",
        name: "invariant_violation",
      }),
    );
  });
});

function fakeAgentCore() {
  return {
    write: vi.fn(async () => ({ command: "read", status: "success", isError: false, text: "" })),
    recover: vi.fn(async () => undefined),
    commitResponse: vi.fn(async (responseId: string) => ({
      responseId,
      documentCount: 0,
      updateCount: 0,
      documents: [],
      stagedCreates: { committed: [], discarded: [] },
    })),
    rollbackResponse: vi.fn(async (responseId: string) => ({
      responseId,
      stagedCreates: { committed: [], discarded: [] },
    })),
    bufferedUpdatesForDoc: vi.fn(() => []),
    stagedCreatedDocumentIds: vi.fn(() => []),
    getAvailability: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    reverse: vi.fn(),
    undoTurn: vi.fn(),
    redoTurn: vi.fn(),
    invalidateThread: vi.fn(),
  } as unknown;
}

function createTestFacade(options: TestFacadeOptions = {}): CollabDomain {
  return createTestHarness(options).domain;
}

function createTestHarness(options: TestFacadeOptions = {}): {
  domain: CollabDomain;
  journal: ReturnType<typeof createInMemoryJournal>;
  draftStore: ReturnType<typeof createInMemoryDraftStore>;
} {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const draftStore = createInMemoryDraftStore([[THREAD_ID as never, WORK_ID]]);
  return {
    domain: createFacade({
      journal,
      coordinator,
      lifecycle: createInMemoryDocumentLifecycle(coordinator),
      store: storeFor(journal),
      hocuspocus: () => null,
      bindHocuspocus: (_instance: Hocuspocus) => {},
      eventSink: options.eventSink,
      documentWriteHook: options.hook,
      draftStore,
      draftAcceptJournal: createInMemoryDraftAcceptJournal(journal, draftStore.getDraft),
      liveLineage: {
        async listLiveDocumentsForTurn(threadId, turnId) {
          return (await journal.documentsForTurn(threadId, turnId)).map((documentId) => ({
            documentId: documentId as DocumentId,
            uri: documentId,
            scope: "live" as const,
          }));
        },
        async listEditedDocumentsForTurn(threadId, turnId) {
          return (await journal.documentsForTurn(threadId, turnId)).map((documentId) => ({
            documentId: documentId as DocumentId,
            uri: documentId,
            scope: "live" as const,
          }));
        },
      },
      threads: {
        async findById(id) {
          return id === THREAD_ID
            ? {
                userId: USER_ID,
                projectId: "project-1",
              }
            : null;
        },
      },
      resolveWorkWriteMode: async () => options.aiWriteMode ?? "direct",
      ...(options.branchStore ? { branchStore: options.branchStore as never } : {}),
    }),
    journal,
    draftStore,
  };
}

function storeFor(journal: ReturnType<typeof createInMemoryJournal>): CollabFacadeStore {
  return {
    createCheckpoint: (docId, state, reason, upToSeq) =>
      journal.createCheckpoint(docId, state, reason, upToSeq),
    getCheckpoint: (id) => journal.getCheckpoint(id),
    listCheckpoints: (docId) => journal.listCheckpoints(docId),
    latestUpdate: (docId) => journal.latestUpdate(docId),
    latestUpdateSeq: (docId) => journal.latestUpdateSeq(docId),
  };
}

function updateAuthoredBy(clientId: number): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientId;
  const before = Y.encodeStateVector(doc);
  doc.getMap("connection").set("value", clientId);
  return { doc, update: Y.encodeStateAsUpdate(doc, before) };
}
