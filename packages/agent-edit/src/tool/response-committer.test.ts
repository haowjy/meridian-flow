// Response committer lifecycle invariants: observer failures must not alter outcomes.

import { describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { createStaticDocumentLinks } from "../ports/static-document-links.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { blockTexts } from "./test-support/assertions.js";
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
    const readRoom = prepared.coordinator.readRoom.bind(prepared.coordinator);
    let reads = 0;
    let pauseNext = false;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    prepared.coordinator.readRoom = async (docId, staged) => {
      reads += 1;
      if (pauseNext) {
        pauseNext = false;
        entered();
        await gate;
      }
      return readRoom(docId, staged);
    };
    // Every save's prepared write is counted, so the commit below proves it was consumed.
    const saves = { persisted: 0, transferred: 0 };
    const prepareSave = prepared.coordinator.prepareSave.bind(prepared.coordinator);
    prepared.coordinator.prepareSave = async (request) => {
      const saved = await prepareSave(request);
      const { write } = saved;
      if (write.kind !== "write") return saved;
      return {
        ...saved,
        write: {
          ...write,
          persist: async () => {
            saves.persisted += 1;
            return write.persist();
          },
          transfer: () => {
            saves.transferred += 1;
            write.transfer();
          },
        },
      };
    };
    const peer = {
      ...context,
      responseIdentity: { providerResponseId: "prepared-abort", editScopeId: "prepared-abort" },
      turnId: "prepared-turn",
      interactionContext: { mode: "threadPeer" as const },
    };
    const scope = { threadId: THREAD_ID, responseId: peer.responseIdentity.editScopeId };
    await prepared.core.read({ file: "chapter.md" }, peer);
    expect(
      (await prepared.core.write({ command: "insert", file: "chapter.md", content: "Beta." }, peer))
        .status,
    ).toBe("success");
    // Every call's room copy is its own: changing one reaches no later read.
    const borrowed = await prepared.core.readRoom("chapter.md", scope);
    borrowed.doc.getMap("foreign").set("must-stay-on-replica", true);
    borrowed.dispose();
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
    // A read racing a later stage of its scope reads again, so it never hides that write.
    pauseNext = true;
    const reading = prepared.core.readRoom("chapter.md", scope);
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
    try {
      expect(blockTexts(current.doc)).toEqual(["Pink.", "Beta.", "Gamma."]);
      expect(current.doc.getMap("foreign").size).toBe(0);
    } finally {
      current.dispose();
    }
    expect((await prepared.core.read({ file: "chapter.md" }, peer)).result.message).toBeUndefined();
    const readCount = reads;
    const readers = await Promise.all(
      Array.from({ length: 12 }, () => prepared.core.readRoom("chapter.md", scope)),
    );
    for (const reader of readers) {
      expect(blockTexts(reader.doc)).toEqual(["Pink.", "Beta.", "Gamma."]);
      reader.dispose();
    }
    expect(reads - readCount).toBe(12);
    mutateSaveLinks = true;
    failSaveLinks = true;
    const failed = await prepared.core.commitResponse(peer.responseIdentity.editScopeId);
    expect(failed.documents[0]?.receipts[0]?.result.awarenessDegraded).toBe(true);
    expect(saveReplicas.length).toBeGreaterThan(0);
    expect(saveReplicas.every((doc) => doc.isDestroyed)).toBe(true);
    expect(saves.persisted).toBeGreaterThan(0);
    expect(saves.transferred).toBe(saves.persisted);
  });

  it("commits a multi-document thread-peer response, one journal batch per document", async () => {
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
      ["alpha.md:turn-alpha.md"],
      ["beta.md:turn-beta.md"],
    ]);
    expect(blockTexts(ctx.liveDoc("alpha.md"))).toEqual(["Alpha.", "Tail."]);
    expect(blockTexts(ctx.liveDoc("beta.md"))).toEqual(["Beta.", "Tail."]);
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
    ctx.core.dropStaged("chapter.md", THREAD_ID);
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

  it("does not reclassify a persisted save when onTransition throws on journal_staged", async () => {
    const transitions: ResponseCommitterTransitionDetail[] = [];
    const ctx = harness(
      { "chapter.md": "Alpha." },
      {
        onResponseCommitterTransition: (event) => {
          transitions.push(event);
          if (event.transition === "journal_staged") {
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
      expect.arrayContaining(["journal_staged", "closed"]),
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
    interactionContext: { mode: "threadPeer" as const, peerDraftId },
  });
  const receiptTexts = (
    result: Awaited<ReturnType<ReturnType<typeof harness>["core"]["commitResponse"]>>,
  ) =>
    result.documents.flatMap((document) =>
      document.receipts.map((receipt) => JSON.stringify(receipt)),
    );

  it("rolls a staged thread-peer reply back without saving anything (U5)", async () => {
    const ctx = harness({ "chapter.md": "Alpha." });
    const responseId = "response-rollback";
    await ctx.core.read({ file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "One." },
      peerContext(responseId, "peer-1", "turn-1"),
    );
    const prepareSave = vi.spyOn(ctx.coordinator, "prepareSave");

    await ctx.core.rollbackResponse(responseId);

    expect(prepareSave).not.toHaveBeenCalled();
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
