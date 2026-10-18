// Response committer lifecycle invariants: observer failures must not alter outcomes.

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { unwrapDoc } from "../handles.js";
import type { StagedWriteHost } from "../ports/document-coordinator.js";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { blockTexts, outcomeText } from "./test-support/assertions.js";
import { context, harness, THREAD_ID } from "./test-support/write-tool-harness.js";
import type { ResponseCommitterTransitionDetail } from "./types.js";

describe("response committer", () => {
  it("defers lifecycle close and restores buffered ownership when the host transaction aborts", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseCommitterTransition: (event) => transitions.push(event) },
    );
    const responseId = "response-deferred-close";
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      {
        ...context,
        responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
        turnId: "turn-deferred-close",
      },
    );
    let participant: { commit(): void | Promise<void>; abort(): void | Promise<void> } | undefined;

    await ctx.core.commitResponse(responseId, {
      deferFinalization: (deferred) => {
        participant = deferred;
      },
    });
    expect(transitions.some((event) => event.transition === "closed")).toBe(false);
    await participant?.abort();
    expect(ctx.core.hasResponseDocument(responseId, "chapter.md")).toBe(true);
  });

  it("delivers deferred lifecycle close only after the host commits", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseCommitterTransition: (event) => transitions.push(event) },
    );
    const responseId = "response-deliver-close";
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      {
        ...context,
        responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
        turnId: "turn-deliver-close",
      },
    );
    let commit = async () => {};
    await ctx.core.commitResponse(responseId, {
      deferFinalization: (participant) => {
        commit = async () => participant.commit();
      },
    });
    expect(transitions.some((event) => event.transition === "closed")).toBe(false);
    await commit();
    expect(transitions.at(-1)).toMatchObject({
      transition: "closed",
      closedOutcome: "committed",
    });

    const links = createStaticDocumentLinks();
    let mutateSaveLinks = false;
    let failSaveLinks = false;
    const saveReplicas: Y.Doc[] = [];
    const openLinks = links.prepare.bind(links);
    links.prepare = async (request) => {
      if (mutateSaveLinks) {
        saveReplicas.push(...request.docs);
        for (const doc of request.docs)
          doc.getMap("save-link-adapter").set("must-stay-on-replica", true);
        if (failSaveLinks) throw new Error("link preparation refused");
      }
      return openLinks(request);
    };
    const prepared = harness({ "chapter.md": "Alpha." }, { links });
    const snapshots: {
      bytes: Uint8Array;
      cut: import("../ports/document-coordinator.js").StagedHelperCut;
    }[] = [];
    let pauseNext = false;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A save's prepared write is counted, so the commit below proves it was consumed.
    const saves = { persisted: 0, transferred: 0 };
    const replay: StagedWriteHost["replay"] = async (request) => {
      if (pauseNext) {
        pauseNext = false;
        entered();
        await gate;
      }
      snapshots.push({ bytes: Y.encodeStateAsUpdate(request.sourceDoc), cut: request.helperCut });
      return prepared.coordinator.withDocument(request.docId, async (canonical) => {
        const candidate = new Y.Doc({ gc: false });
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(canonical));
        for (const entry of request.entries) Y.applyUpdate(candidate, entry.update);
        const state = Y.encodeStateAsUpdate(candidate);
        candidate.destroy();
        return {
          keptEntries: request.entries,
          helperState: state,
          helperCut: { generation: 1, state: Y.encodeStateAsUpdate(canonical) },
          beforeState: Y.encodeStateAsUpdate(canonical),
        };
      });
    };
    const stagedWrites: StagedWriteHost = {
      replay,
      prepareSave: async (request) => ({
        ...(await replay(request)),
        write: {
          kind: "write",
          persist: async () => {
            saves.persisted += 1;
          },
          transfer: () => {
            saves.transferred += 1;
          },
          dispose: () => {},
        },
      }),
    };
    Object.assign(prepared.coordinator, { stagedWrites });
    const peer = {
      ...context,
      responseIdentity: { providerResponseId: "prepared-abort", editScopeId: "prepared-abort" },
      turnId: "prepared-turn",
      interactionContext: { mode: "threadPeer" as const, draftGeneration: 1, afterJournalId: 0 },
    };
    await prepared.core.read({ file: "chapter.md" }, peer);
    expect(
      (await prepared.core.write({ command: "insert", file: "chapter.md", content: "Beta." }, peer))
        .status,
    ).toBe("success");
    const borrowed = await prepared.core.prepare(peer.responseIdentity.editScopeId, "chapter.md");
    if (!borrowed) throw new Error("Missing prepared lease");
    unwrapDoc(borrowed.doc).getMap("foreign").set("must-stay-on-replica", true);
    borrowed.dispose();
    const before = snapshots.at(-1);
    await prepared.core.write(
      { command: "replace", file: "chapter.md", find: "Alpha.", content: "Pink." },
      context,
    );
    let rollback: { commit(): void | Promise<void>; abort(): void | Promise<void> } | undefined;
    await prepared.core.rollbackResponse(peer.responseIdentity.editScopeId, {
      deferFinalization: (deferred) => {
        rollback = deferred;
      },
    });
    await rollback?.abort();
    (await prepared.core.prepare(peer.responseIdentity.editScopeId, "chapter.md"))?.dispose();
    expect(snapshots.at(-1)).toEqual(before);
    // A scoped read replay started before a later stage must not reject that new write.
    pauseNext = true;
    const reading = prepared.core.prepare(peer.responseIdentity.editScopeId, "chapter.md");
    await waiting;
    try {
      expect(
        (
          await prepared.core.write(
            { command: "insert", file: "chapter.md", content: "Gamma." },
            peer,
          )
        ).status,
      ).toBe("success");
    } finally {
      release();
    }
    const current = await reading;
    if (!current) throw new Error("Missing read lease");
    try {
      expect(blockTexts(unwrapDoc(current.doc))).toEqual(["Pink.", "Beta.", "Gamma."]);
    } finally {
      current.dispose();
    }
    expect((await prepared.core.read({ file: "chapter.md" }, peer)).result.message).toBeUndefined();
    const replayCount = snapshots.length;
    const readers = await Promise.all(
      Array.from({ length: 12 }, () =>
        prepared.core.prepare(peer.responseIdentity.editScopeId, "chapter.md"),
      ),
    );
    for (const reader of readers) {
      if (!reader) throw new Error("Missing concurrent read lease");
      expect(blockTexts(unwrapDoc(reader.doc))).toEqual(["Pink.", "Beta.", "Gamma."]);
      reader.dispose();
    }
    expect(snapshots.length - replayCount).toBe(12);
    mutateSaveLinks = true;
    failSaveLinks = true;
    await expect(prepared.core.commitResponse(peer.responseIdentity.editScopeId)).rejects.toThrow(
      "link preparation refused",
    );
    expect(saveReplicas.length).toBeGreaterThan(0);
    expect(saveReplicas.every((doc) => doc.isDestroyed)).toBe(true);
    failSaveLinks = false;
    await prepared.core.commitResponse(peer.responseIdentity.editScopeId, {
      deferFinalization: (deferred) => {
        rollback = deferred;
      },
    });
    expect(saves.persisted).toBeGreaterThan(0);
    expect(saves.transferred).toBe(saves.persisted);
    const checkSaveReplica = () => {
      const snapshot = snapshots.at(-1);
      if (!snapshot) throw new Error("Missing replay source");
      const source = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(source, snapshot.bytes);
        expect(source.getMap("save-link-adapter").size).toBe(0);
      } finally {
        source.destroy();
      }
    };
    checkSaveReplica();
    expect(saveReplicas.every((doc) => doc.isDestroyed)).toBe(true);
    await rollback?.abort();
    (await prepared.core.prepare(peer.responseIdentity.editScopeId, "chapter.md"))?.dispose();
    checkSaveReplica();
    await prepared.core.rollbackResponse(peer.responseIdentity.editScopeId);
    expect(prepared.core.hasResponseDocument(peer.responseIdentity.editScopeId, "chapter.md")).toBe(
      false,
    );
  });

  it("commits a multi-document thread-peer response in one journal batch", async () => {
    const ctx = harness({ "alpha.md": "Alpha.", "beta.md": "Beta." });
    const responseId = "response-multi-thread-peer";
    await ctx.core.read({ file: "alpha.md" }, context);
    await ctx.core.read({ file: "beta.md" }, context);
    for (const file of ["alpha.md", "beta.md"]) {
      await ctx.core.write(
        { command: "insert", file, content: "Tail." },
        {
          ...context,
          responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
          turnId: `turn-${file}`,
          interactionContext: {
            mode: "threadPeer",
            draftGeneration: 1,
            peerDraftId: "draft-peer",
          },
        },
      );
    }

    await expect(ctx.core.commitResponse(responseId)).resolves.toMatchObject({
      status: "committed",
      documentCount: 2,
    });
    expect(ctx.journal.recordedBatches()).toEqual([
      ["alpha.md:turn-alpha.md", "beta.md:turn-beta.md"],
    ]);
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha.", "Tail."]);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["Beta.", "Tail."]);
  });

  it("closes a durable response when projection and recovery both fail", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    let ctx!: ReturnType<typeof harness>;
    ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onResponseCommitterTransition: (event) => transitions.push(event),
        afterResponsePreflight: () => ctx.coordinator.failWith(new Error("projection failed")),
      },
    );
    const responseId = "response-durable-projection-recovery-failure";
    const responseContext = {
      ...context,
      turnId: "turn-durable-projection-recovery-failure",
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    };
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Durable words." },
      responseContext,
    );

    const originalRecover = ctx.coordinator.recover.bind(ctx.coordinator);
    const recover = vi
      .spyOn(ctx.coordinator, "recover")
      .mockRejectedValueOnce(new Error("recovery failed"));

    await expect(ctx.core.commitResponse(responseId)).rejects.toThrow("projection failed");
    expect(transitions.at(-1)).toMatchObject({
      transition: "closed",
      closedOutcome: "committed",
      journalCommitKind: "durable",
    });
    await expect(ctx.core.commitResponse(responseId)).rejects.toThrow("already committed");
    const staged = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Must not stage." },
      responseContext,
    );
    expect(staged).toMatchObject({ status: "invalid_write", isError: true });
    expect(outcomeText(staged)).toContain("already committed");

    ctx.coordinator.failWith(undefined);
    recover.mockImplementation(originalRecover);
    await ctx.core.read({ file: "chapter.md" }, context);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("rejects staging while a response commit owns its snapshot", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-stage-during-commit";
    const responseContext = {
      ...context,
      turnId: "turn-stage-during-commit",
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    };
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    const appendStarted = deferred<void>();
    const releaseAppend = deferred<void>();
    const originalAppend = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) => {
      appendStarted.resolve();
      await releaseAppend.promise;
      return originalAppend(entries);
    };

    const commit = ctx.core.commitResponse(responseId);
    await appendStarted.promise;
    const staged = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Too late." },
      responseContext,
    );
    expect(staged.status).toBe("internal_error");
    releaseAppend.resolve();
    await commit;
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });

  it("does not drop a commit snapshot while append is in progress", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      { onResponseCommitterTransition: (event) => transitions.push(event) },
    );
    const responseId = "response-drop-during-append";
    const responseContext = {
      ...context,
      turnId: "turn-drop-during-append",
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    };
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );
    const appendStarted = deferred<void>();
    const releaseAppend = deferred<void>();
    const originalAppend = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) => {
      appendStarted.resolve();
      await releaseAppend.promise;
      return originalAppend(entries);
    };
    const commit = ctx.core.commitResponse(responseId);
    await appendStarted.promise;
    await ctx.core.invalidateThreadDocument("chapter.md", THREAD_ID);
    releaseAppend.resolve();
    const result = await commit;
    if (result.status !== "committed") throw new Error("expected committed response");
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
    expect(result.discardedClaims).toBeUndefined();
    expect(
      transitions
        .filter((event) => event.transition === "closed")
        .map((event) => event.closedOutcome),
    ).toEqual(["committed"]);
  });

  it("does not reclassify a durable journal commit when onTransition throws on journal_committed", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onResponseCommitterTransition: (event) => {
          transitions.push(event);
          if (event.transition === "journal_committed") {
            throw new Error("observer exploded");
          }
        },
      },
    );
    const responseContext = {
      ...context,
      turnId: "turn-observer-throw",
      responseIdentity: {
        providerResponseId: "response-observer-throw",
        editScopeId: "response-observer-throw",
      },
    };

    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );

    const commit = await ctx.core.commitResponse("response-observer-throw");

    expect(commit).toMatchObject({
      responseId: "response-observer-throw",
      documentCount: 1,
      updateCount: 1,
    });
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
    expect(transitions.map((event) => event.transition)).toEqual(
      expect.arrayContaining(["journal_committed", "closed"]),
    );
    expect(transitions.find((event) => event.transition === "closed")).toMatchObject({
      closedOutcome: "committed",
      threadId: context.threadId,
    });
  });

  it("appends exactly one journal batch when commitResponse is invoked concurrently", async () => {
    let appendBatchInFlight = 0;
    const ctx = harness(
      { "chapter.md": "Alpha." },
      {
        journalOverride: (journal) => {
          const originalAppendBatch = journal.appendBatch.bind(journal);
          const gated = journal as typeof journal & {
            appendBatch: typeof journal.appendBatch;
          };
          gated.appendBatch = async (entries) => {
            appendBatchInFlight += 1;
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            });
            try {
              return await originalAppendBatch(entries);
            } finally {
              appendBatchInFlight -= 1;
            }
          };
          return gated as UpdateJournal;
        },
      },
    );
    const responseId = "response-concurrent-commit";
    const responseContext = {
      ...context,
      turnId: "turn-concurrent-commit",
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    };

    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Beta." },
      responseContext,
    );

    const appendStarted = deferred<void>();
    const originalAppend = ctx.journal.appendBatch.bind(ctx.journal);
    ctx.journal.appendBatch = async (entries) => {
      appendStarted.resolve();
      return originalAppend(entries);
    };
    const firstCommit = ctx.core.commitResponse(responseId);
    await appendStarted.promise;
    expect(appendBatchInFlight).toBe(1);
    const secondCommit = ctx.core.commitResponse(responseId);
    await Promise.resolve();
    expect(appendBatchInFlight).toBe(1);

    const [first, second] = await Promise.all([firstCommit, secondCommit]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ responseId, documentCount: 1, updateCount: 1 });
    expect(ctx.journal.recordedBatches()).toHaveLength(1);
    expect((await ctx.journal.read("chapter.md")).updates).toHaveLength(1);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Beta."]);
  });
});

describe("reasoned refusal of staged writes", () => {
  const peerContext = (responseId: string, peerDraftId: string, turn: string) => ({
    ...context,
    turnId: turn,
    responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    interactionContext: { mode: "threadPeer" as const, draftGeneration: 1, peerDraftId },
  });
  const receiptTexts = (
    result: Awaited<ReturnType<ReturnType<typeof harness>["core"]["commitResponse"]>>,
  ) =>
    result.documents.flatMap((document) =>
      document.receipts.map((receipt) => JSON.stringify(receipt)),
    );

  it("rolls a staged thread-peer reply back without any coordinator call (U5)", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-rollback";
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      peerContext(responseId, "peer-1", "turn-1"),
    );
    const withDocument = vi.spyOn(ctx.coordinator, "withDocument");

    await ctx.core.rollbackResponse(responseId);

    expect(withDocument).not.toHaveBeenCalled();
    expect(ctx.core.hasResponseDocument(responseId, "chapter.md")).toBe(false);
  });

  it("a reply whose every document was refused still receipts each write", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-all-refused";
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      peerContext(responseId, "peer-1", "turn-1"),
    );
    ctx.core.refuseStaged(responseId, "chapter.md", "discarded_document");

    const saved = await ctx.core.commitResponse(responseId);
    expect(saved).toMatchObject({ status: "committed", updateCount: 0 });
    expect(receiptTexts(saved).join()).toContain("the user discarded this new document");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha."]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
