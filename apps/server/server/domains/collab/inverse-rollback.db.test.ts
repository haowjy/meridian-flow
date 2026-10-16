/** Consolidated test contracts; each block retains its original fixture scope. */

import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { asGrantedWriter, testFileGrant } from "../../test-support/file-grants.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

__mergedSuite("inverse-rollback.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/inverse-rollback.db.test.ts.
  const db = createTestDatabase();

  const fixture = () => inverseFixture(db);

  beforeEach(() => resetDatabase(db));

  afterAll(() => closeDatabase(db));

  it("failed-response rollback targets the response, is per-part and terminal on retry", async () => {
    const { harness, view, responseId, context } = await fixture();
    try {
      expect(
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find: "Beta",
            content: "Gamma",
            tool_use_id: "first",
          },
          context,
        ),
      ).toMatchObject({ status: "success" });
      await harness.commit(responseId);
      const second = randomUUID();
      await db.insert(schema.modelResponses).values({
        id: second as never,
        turnId: TURN_ID,
        sequence: 2,
        provider: "mock",
        model: "mock",
        requestMessageCount: 1,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      expect(
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find: "Blue",
            content: "Silver",
            tool_use_id: "second",
          },
          { ...context, responseIdentity: { providerResponseId: second, editScopeId: second } },
        ),
      ).toMatchObject({ status: "success" });
      await harness.commit(second);
      await view.collab.finalizeResponseRollback(
        { providerResponseId: second, editScopeId: second },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, ALPHA_ID),
            eq(schema.documentBranches.kind, "work_draft"),
          ),
        );
      expect(await view.draftMarkdown(branch.id)).toBe("Alpha Gamma.\n\nBlue.\n");
      const before = await db
        .select()
        .from(schema.documentEdits)
        .where(eq(schema.documentEdits.kind, "rollback"));
      expect(before).toHaveLength(1);
      await view.collab.finalizeResponseRollback(
        { providerResponseId: second, editScopeId: second },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      expect(
        await db
          .select()
          .from(schema.documentEdits)
          .where(eq(schema.documentEdits.kind, "rollback")),
      ).toHaveLength(1);
      expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
        control: "undo",
        skips: [{ reason: "Rolled back" }],
      });
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("failed response leaves only the writer-dependent draft part rollback_pending", async () => {
    const { harness, view, responseId, context } = await fixture();
    try {
      for (const [find, content] of [
        ["Beta", "Gamma"],
        ["Blue", "Silver"],
      ])
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find,
            content,
            tool_use_id: find,
          },
          context,
        );
      await harness.commit(responseId);
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, ALPHA_ID),
            eq(schema.documentBranches.kind, "work_draft"),
          ),
        );
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, branch.state);
        doc.clientID = allocateDocumentClient(doc);
        const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
        const updates = captureMutationUpdates(doc, () => text.insert(8, "!"));
        await view.branchCoordinator.commitWriterUpdate({
          branchId: branch.id,
          expectedGeneration: branch.generation,
          updateData: Y.mergeUpdates(updates),
          actorUserId: USER_ID,
          roomDocument: doc,
        });
      } finally {
        doc.destroy();
      }
      await view.collab.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      );
      expect(await view.draftMarkdown(branch.id)).toBe("Alpha Ga!mma.\n\nBlue.\n");
      const pending = await db
        .select()
        .from(schema.branchWriteJournal)
        .where(eq(schema.branchWriteJournal.status, "rollback_pending"));
      expect(pending).toHaveLength(1);
      expect(
        await db
          .select()
          .from(schema.documentEdits)
          .where(eq(schema.documentEdits.kind, "rollback")),
      ).toHaveLength(1);
      await view.collab.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      );
      expect(await view.draftMarkdown(branch.id)).toBe("Alpha Ga!mma.\n\nBlue.\n");
      expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
        control: "view_change",
      });
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it.each([
    "live",
    "draft",
  ] as const)("failed edit scope rolls back durable model inverses in %s without losing provider authorship", async (destination) => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      const address = { documentId: ALPHA_ID, file: "alpha.md" };
      const initial =
        destination === "live"
          ? { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) }
          : context;
      await core.read(address, initial);
      expect(
        await core.write(
          { ...address, command: "replace", find: "Beta", content: "Gamma" },
          initial,
        ),
      ).toMatchObject({ status: "success", writeId: "w1" });
      await harness.commit(responseId);
      const responseIdentity = {
        providerResponseId: responseId,
        editScopeId: randomUUID(),
      };
      const inverseContext = { ...initial, responseIdentity };
      for (const command of ["undo", "redo"] as const)
        expect(await core.write({ ...address, command }, inverseContext)).toMatchObject({
          status: "success",
        });
      expect(
        await core.write({ ...address, command: "revert", edit: "w1" }, inverseContext),
      ).toMatchObject({ status: "success", writeId: "w4" });
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, ALPHA_ID),
            eq(schema.documentBranches.kind, "work_draft"),
          ),
        );
      const prose = () =>
        destination === "live" ? harness.liveMarkdown(ALPHA_ID) : view.draftMarkdown(branch.id);
      expect(await prose()).toBe("Alpha Beta.\n\nBlue.\n");
      await view.collab.finalizeResponseRollback(responseIdentity, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      expect(await prose()).toBe("Alpha Gamma.\n\nBlue.\n");
      await view.collab.finalizeResponseRollback(responseIdentity, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      expect(await prose()).toBe("Alpha Gamma.\n\nBlue.\n");
      const rows = await db
        .select()
        .from(schema.documentEdits)
        .where(eq(schema.documentEdits.editScopeId, responseIdentity.editScopeId));
      expect(rows.filter((row) => row.actor === "agent").map((row) => row.responseId)).toEqual([
        responseId,
        responseId,
        responseId,
      ]);
      expect(rows.filter((row) => row.kind === "rollback")).toHaveLength(0);
      const edits = await core.read({ ...address, format: "edits" }, initial);
      expect(edits.result.message).toMatch(/w4.*rolled back/);
      expect(edits.result.message).toMatch(/w1.*undo(?:\n|$)/);
      expect(await core.write({ ...address, command: "redo" }, initial)).toMatchObject({
        status: "nothing_to_redo",
      });
      expect(await db.select().from(schema.modelResponses)).toHaveLength(1);
      if (destination === "draft") {
        const authored = await db
          .select()
          .from(schema.branchWriteJournal)
          .where(
            and(
              eq(schema.branchWriteJournal.branchId, branch.id),
              eq(schema.branchWriteJournal.source, "agent"),
            ),
          );
        const metadata = authored.map(
          (row) =>
            row.updateMeta as {
              authoringResponseId?: string;
              editScopeId?: string;
            },
        );
        expect(metadata.map((meta) => meta.authoringResponseId)).toEqual([
          responseId,
          responseId,
          responseId,
          responseId,
        ]);
        expect(
          metadata.filter((meta) => meta.editScopeId === responseIdentity.editScopeId),
        ).toHaveLength(3);
      }
      if (destination === "live") {
        const journal = await db
          .select()
          .from(schema.documentYjsUpdates)
          .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID));
        expect(
          journal
            .filter((row) => row.authoringResponseId !== null)
            .every((row) => row.authoringResponseId === responseId),
        ).toBe(true);
      }
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("failed redo in a separate scope restores draft availability on retry", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      const address = { documentId: ALPHA_ID, file: "alpha.md" };
      const initial = context;
      await core.read(address, initial);
      expect(
        await core.write(
          { ...address, command: "replace", find: "Beta", content: "Gamma" },
          initial,
        ),
      ).toMatchObject({ status: "success", writeId: "w1" });
      await harness.commit(responseId);
      const saved = {
        ...initial,
        responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
      };
      expect(await core.write({ ...address, command: "undo" }, saved)).toMatchObject({
        status: "success",
        result: { message: "undone: w1" },
      });
      const failed = {
        ...initial,
        responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
      };
      expect(await core.write({ ...address, command: "redo" }, failed)).toMatchObject({
        status: "success",
      });
      const draft = (
        await db
          .select({ draftId: schema.documentBranches.id })
          .from(schema.documentBranches)
          .where(
            and(
              eq(schema.documentBranches.documentId, ALPHA_ID),
              eq(schema.documentBranches.kind, "work_draft"),
            ),
          )
      )[0];
      const text = () => view.draftMarkdown(draft.draftId);
      expect(await text()).toBe("Alpha Gamma.\n\nBlue.\n");
      for (let retry = 0; retry < 2; retry++) {
        await view.collab.finalizeResponseRollback(failed.responseIdentity, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        });
        expect(await text()).toBe("Alpha Beta.\n\nBlue.\n");
        const edits = await core.read({ ...address, format: "edits" }, saved);
        const original = edits.result.message?.split("\n").find((line) => line.startsWith("w1  "));
        expect(original).toMatch(/undone.* {2}redo$/);
        expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
          state: "live-reversed",
          control: "redo",
        });
      }
      const retry = {
        ...saved,
        responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
      };
      expect(await core.write({ ...address, command: "redo" }, retry)).toMatchObject({
        status: "success",
        result: { message: "redone: w1" },
      });
      expect(await text()).toBe("Alpha Gamma.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

__mergedSuite("response-rollback.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/response-rollback.db.test.ts.
  const db = createTestDatabase();

  beforeEach(() => resetDatabase(db));

  afterAll(() => closeDatabase(db));

  async function fixture() {
    const harness = createHarness(db),
      view = harness.crossWorkProbeFixture(),
      responseId = randomUUID();
    await db.insert(schema.modelResponses).values({
      id: responseId as never,
      turnId: TURN_ID,
      sequence: 1,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    await harness.seedWriterDocument("Alpha Beta.\n\nBlue.", responseId);
    const context = {
      sessionId: THREAD_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
      grant: testFileGrant({
        kind: "draft",
        workId: WORK_ID,
        workSlug: "atomicity-work",
      }),
    };
    return { harness, view, responseId, context };
  }

  it.each([
    { kind: "insert", edited: true },
    { kind: "delete", edited: true },
    { kind: "replace", edited: false },
    { kind: "replace", edited: true },
  ] as const)("immediate live $kind rollback respects writer dependencies (edited=$edited)", async ({
    kind,
    edited,
  }) => {
    const { harness, view, responseId, context } = await fixture();
    try {
      const immediate = {
        ...context,
        responseIdentity: undefined,
        grant: testFileGrant({ kind: "live" }, ALPHA_ID),
        actor: {
          kind: "agent" as const,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
          editScopeId: responseId,
        },
      };
      await view.collab.agentEdit().read({ file: "alpha.md", documentId: ALPHA_ID }, immediate);
      const content = kind === "delete" ? "" : "Gamma";
      for (const [find, replacement] of [
        ["Beta", content],
        ["Blue", kind === "delete" ? "" : "Silver"],
      ]) {
        const outcome = await asGrantedWriter(() =>
          view.collab.agentEdit().write(
            {
              command: kind === "insert" ? "insert" : "replace",
              documentId: ALPHA_ID,
              file: "alpha.md",
              find,
              content: replacement,
              tool_use_id: find,
            },
            immediate,
          ),
        );
        expect(outcome).toMatchObject({ status: "success", phase: "committed" });
      }
      if (edited)
        await writeMarkdown(view.collab, {
          documentId: ALPHA_ID,
          markdown:
            kind === "insert"
              ? "Alpha BetaGamma!.\n\nBlueSilver."
              : kind === "delete"
                ? "Alpha !.\n\n."
                : "Alpha Ga!mma.\n\nSilver.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID,
        });
      await view.collab.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      );
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
        !edited
          ? "Alpha Beta.\n\nBlue.\n"
          : kind === "insert"
            ? "Alpha BetaGamma!.\n\nBlue.\n"
            : kind === "delete"
              ? "Alpha !.\n\nBlue.\n"
              : "Alpha Ga!mma.\n\nBlue.\n",
      );
      const rollbackParts = await db
        .select()
        .from(schema.documentEditParts)
        .innerJoin(
          schema.documentEdits,
          eq(schema.documentEditParts.editId, schema.documentEdits.id),
        )
        .where(eq(schema.documentEdits.kind, "rollback"));
      expect(rollbackParts).toHaveLength(edited ? 1 : 2);
      await view.collab.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      );
      expect(
        await db
          .select()
          .from(schema.documentEditParts)
          .innerJoin(
            schema.documentEdits,
            eq(schema.documentEditParts.editId, schema.documentEdits.id),
          )
          .where(eq(schema.documentEdits.kind, "rollback")),
      ).toHaveLength(edited ? 1 : 2);
      expect((await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID))?.control).not.toBe("redo");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it("failed response rolls back immediate live and draft parts while keeping a writer-dependent draft part", async () => {
    const { harness, view, responseId, context } = await fixture();
    try {
      await writeMarkdown(view.collab, {
        documentId: BETA_ID,
        markdown: "Delta Echo.\n\nGreen.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID,
      });
      const actor = {
        kind: "agent" as const,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId,
        editScopeId: responseId,
      };
      await view.collab.agentEdit().read(
        { file: "alpha.md", documentId: ALPHA_ID },
        {
          ...context,
          responseIdentity: undefined,
          actor,
          grant: testFileGrant({ kind: "live" }, ALPHA_ID),
        },
      );
      await view.collab.agentEdit().read(
        { file: "beta.md", documentId: BETA_ID },
        {
          ...context,
          responseIdentity: undefined,
          actor,
          grant: testFileGrant(
            { kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" },
            BETA_ID,
          ),
        },
      );
      expect(
        await asGrantedWriter(() =>
          view.collab.agentEdit().write(
            {
              command: "replace",
              documentId: ALPHA_ID,
              file: "alpha.md",
              find: "Beta",
              content: "Gamma",
              tool_use_id: "live",
            },
            {
              ...context,
              responseIdentity: undefined,
              actor,
              grant: testFileGrant({ kind: "live" }, ALPHA_ID),
            },
          ),
        ),
      ).toMatchObject({ status: "success", phase: "committed" });
      for (const [find, content] of [
        ["Echo", "Amber"],
        ["Green", "Gold"],
      ])
        expect(
          await asGrantedWriter(() =>
            view.collab.agentEdit().write(
              {
                command: "replace",
                documentId: BETA_ID,
                file: "beta.md",
                find,
                content,
                tool_use_id: find,
              },
              {
                ...context,
                responseIdentity: undefined,
                actor,
                grant: testFileGrant(
                  { kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" },
                  BETA_ID,
                ),
              },
            ),
          ),
        ).toMatchObject({ status: "success", phase: "committed" });
      const betaBranch = await view.branchStore.resolveWorkDraftBranchForThread(BETA_ID, THREAD_ID);
      betaBranch.doc.destroy();
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.id, betaBranch.branchId));
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, branch.state);
        doc.clientID = allocateDocumentClient(doc);
        const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
        const updates = captureMutationUpdates(doc, () => text.insert(8, "!"));
        await view.branchCoordinator.commitWriterUpdate({
          branchId: branch.id,
          expectedGeneration: branch.generation,
          updateData: Y.mergeUpdates(updates),
          actorUserId: USER_ID,
          roomDocument: doc,
        });
      } finally {
        doc.destroy();
      }
      await view.collab.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      );
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      expect(await harness.liveMarkdown(BETA_ID)).toBe("Delta Echo.\n\nGreen.\n");
      expect(await view.draftMarkdown(branch.id)).toBe("Delta Am!ber.\n\nGreen.\n");
      expect(
        await db
          .select()
          .from(schema.branchWriteJournal)
          .where(eq(schema.branchWriteJournal.status, "rollback_pending")),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(schema.documentEdits)
          .where(eq(schema.documentEdits.kind, "rollback")),
      ).toHaveLength(2);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

__mergedSuite("inverse-attribution.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/inverse-attribution.db.test.ts.
  const db = createTestDatabase();

  const fixture = () => inverseFixture(db);

  beforeEach(() => resetDatabase(db));

  afterAll(() => closeDatabase(db));

  it("an already-connected live room sees Undo, Redo and immediate rollback without a repairing read", async () => {
    const { harness, view, responseId, context } = await fixture();
    const peer = new Y.Doc({ gc: false });
    try {
      const immediate = {
        ...context,
        responseIdentity: undefined,
        grant: testFileGrant({ kind: "live" }, ALPHA_ID),
        actor: {
          kind: "agent" as const,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
          editScopeId: responseId,
        },
      };
      await view.collab.agentEdit().read({ file: "alpha.md", documentId: ALPHA_ID }, immediate);
      const room = view.hocuspocus.documents.get(ALPHA_ID);
      if (!room) throw new Error("Room was not connected");
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));
      room.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
      const prose = () =>
        peer
          .getXmlFragment("prosemirror")
          .toArray()
          .map((node) =>
            node instanceof Y.XmlElement
              ? node
                  .toArray()
                  .map((child) => (child instanceof Y.XmlText ? child.toString() : ""))
                  .join("")
              : "",
          )
          .join("\n\n");
      expect(
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find: "Beta",
            content: "Gamma",
            tool_use_id: "immediate",
          },
          immediate,
        ),
      ).toMatchObject({ status: "success", phase: "committed" });
      // Reading the fixture creates an empty default draft. Retire it before observing the no-draft room.
      await db
        .update(schema.documentBranches)
        .set({ status: "closed" })
        .where(
          and(
            eq(schema.documentBranches.documentId, ALPHA_ID),
            eq(schema.documentBranches.kind, "work_draft"),
          ),
        );
      expect(await view.branchStore.listActiveWorkDraftBranchIds(ALPHA_ID)).toEqual([]);
      expect(prose()).toBe("Alpha Gamma.\n\nBlue.");
      for (const direction of ["undo", "redo"] as const) {
        const broadcasts = view.hocuspocus.broadcasts.length;
        expect(
          await view.collab.reverseTurn({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            direction,
            actor: { type: "user", userId: USER_ID },
          }),
        ).toMatchObject({ status: "reversed", acceptedParts: 1 });
        expect(view.hocuspocus.broadcasts.length).toBeGreaterThan(broadcasts);
        expect(prose()).toBe(
          direction === "undo" ? "Alpha Beta.\n\nBlue." : "Alpha Gamma.\n\nBlue.",
        );
      }
      const broadcasts = view.hocuspocus.broadcasts.length;
      await view.collab.finalizeResponseRollback(
        { providerResponseId: responseId, editScopeId: responseId },
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        },
      );
      expect(view.hocuspocus.broadcasts.length).toBeGreaterThan(broadcasts);
      expect(prose()).toBe("Alpha Beta.\n\nBlue.");
    } finally {
      peer.destroy();
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  it.each([
    "undo",
    "rollback",
    "redo",
  ] as const)("%s through the receipt service signals and reopens the original settled trail", async (action) => {
    const { harness, view, responseId, context } = await fixture();
    try {
      expect(
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find: "Beta",
            content: "Gamma",
            tool_use_id: "trail-inverse",
          },
          context,
        ),
      ).toMatchObject({ status: "success", phase: "staged" });
      await harness.commit(responseId);
      if (action === "redo") {
        expect(
          await view.collab.reverseTurn({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            direction: "undo",
            actor: { type: "user", userId: USER_ID },
          }),
        ).toMatchObject({ status: "reversed", acceptedParts: 1, skips: [] });
      }
      await db.update(schema.turns).set({ status: "complete" }).where(eq(schema.turns.id, TURN_ID));
      const writer = createDrizzleChangeTrailAggregateWriter(db);
      await writer.reconcileTerminalOwners();
      await writer.reconcileTerminalOwners();
      const [settled] = await db
        .select()
        .from(schema.changeTrailShells)
        .where(eq(schema.changeTrailShells.turnId, TURN_ID));
      expect(settled.state).toBe("settled");
      expect(
        await db
          .select()
          .from(schema.changeTrailDirtyLog)
          .where(eq(schema.changeTrailDirtyLog.turnId, TURN_ID)),
      ).toEqual([]);
      if (action !== "rollback") {
        expect(
          await view.collab.reverseTurn({
            threadId: THREAD_ID,
            turnId: TURN_ID,
            direction: action,
            actor: { type: "user", userId: USER_ID },
          }),
        ).toMatchObject({ status: "reversed", acceptedParts: 1, skips: [] });
      } else {
        await harness.rollbackResponse(responseId);
      }
      const [inverse] = await db
        .select()
        .from(schema.documentEdits)
        .where(eq(schema.documentEdits.kind, action));
      expect(inverse).toMatchObject({ threadId: null, turnId: null });
      expect(
        await db
          .select()
          .from(schema.changeTrailDirtyLog)
          .where(eq(schema.changeTrailDirtyLog.turnId, TURN_ID)),
      ).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: THREAD_ID })]));
      // A cold reconciler discovers only durable signals, not service-local owner enrollment.
      await createDrizzleChangeTrailAggregateWriter(db).reconcileTerminalOwners();
      const [reopened] = await db
        .select()
        .from(schema.changeTrailShells)
        .where(eq(schema.changeTrailShells.turnId, TURN_ID));
      expect(reopened).toMatchObject({ state: "settling", settledAt: null });
      expect(reopened.version).toBeGreaterThan(settled.version);
      expect(
        await db
          .select()
          .from(schema.changeTrailDeliveryOutbox)
          .where(eq(schema.changeTrailDeliveryOutbox.trailId, settled.id)),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ version: reopened.version, eventKind: "updated" }),
        ]),
      );
      if (action === "redo") {
        const [branch] = await db
          .select()
          .from(schema.documentBranches)
          .where(
            and(
              eq(schema.documentBranches.documentId, ALPHA_ID),
              eq(schema.documentBranches.kind, "work_draft"),
            ),
          );
        expect(await view.draftMarkdown(branch.id)).toBe("Alpha Gamma.\n\nBlue.\n");
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
        expect(await reviewDriver(view.collab.draftReview).applyItem(ALPHA_ID)).toMatchObject({
          status: "applied",
        });
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
        expect(await db.select().from(schema.pushLineage)).not.toEqual([]);
        await createDrizzleChangeTrailAggregateWriter(db).reconcileTerminalOwners();
        await createDrizzleChangeTrailAggregateWriter(db).reconcileTerminalOwners();
        const [resettled] = await db
          .select()
          .from(schema.changeTrailShells)
          .where(eq(schema.changeTrailShells.turnId, TURN_ID));
        expect(resettled).toMatchObject({
          state: "settled",
          settledAt: expect.any(Date),
          changeCount: 1,
          documentCount: 1,
        });
        expect(resettled.version).toBeGreaterThan(reopened.version);
        expect(
          await db
            .select()
            .from(schema.changeTrailDeliveryOutbox)
            .where(eq(schema.changeTrailDeliveryOutbox.trailId, settled.id)),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              version: resettled.version,
              eventKind: "settled",
              documents: [expect.objectContaining({ documentId: ALPHA_ID })],
            }),
          ]),
        );
      }
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

__mergedSuite("inverse-actions.db.test.ts: rollback", () => {
  // Merged from apps/server/server/domains/collab/inverse-actions.db.test.ts: rollback.
  const db = createTestDatabase();

  const fixture = () => inverseFixture(db);

  beforeEach(() => resetDatabase(db));

  afterAll(() => closeDatabase(db));

  it("a rolled-back newer Undo does not mask the older effective action in draft", async () => {
    const destination = "draft" as const;
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      const address = { documentId: ALPHA_ID, file: "alpha.md" };
      const initial = context;
      await core.read(address, initial);
      for (const [find, content] of [
        ["Beta", "Gamma"],
        ["Blue", "Silver"],
      ])
        expect(
          await core.write({ ...address, command: "replace", find, content }, initial),
        ).toMatchObject({ status: "success" });
      await harness.commit(responseId);
      const saved = {
        ...initial,
        responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
      };
      expect(await core.write({ ...address, command: "undo" }, saved)).toMatchObject({
        status: "success",
        result: { message: "undone: w2" },
      });
      const failed = {
        ...initial,
        responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
      };
      expect(await core.write({ ...address, command: "undo" }, failed)).toMatchObject({
        status: "success",
        result: { message: "undone: w1" },
      });
      const draft = (
        await db
          .select({ draftId: schema.documentBranches.id })
          .from(schema.documentBranches)
          .where(
            and(
              eq(schema.documentBranches.documentId, ALPHA_ID),
              eq(schema.documentBranches.kind, "work_draft"),
            ),
          )
      )[0];
      const text = () => view.draftMarkdown(draft.draftId);
      expect(await text()).toBe("Alpha Beta.\n\nBlue.\n");
      for (let retry = 0; retry < 2; retry++) {
        await view.collab.finalizeResponseRollback(failed.responseIdentity, {
          threadId: THREAD_ID,
          turnId: TURN_ID,
        });
        expect(await text()).toBe("Alpha Gamma.\n\nBlue.\n");
        const edits = await core.read({ ...address, format: "edits" }, saved);
        expect(edits.result.message).toMatch(/w2 {2}this turn {2}undone.* {2}redo(?:\n|$)/);
        expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
          state: "live-reversed",
          control: "redo",
          skips: [],
        });
      }
      expect(
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: "redo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).toMatchObject({ status: "reversed", acceptedParts: 1 });
      expect(await text()).toBe("Alpha Gamma.\n\nSilver.\n");
      expect(await core.write({ ...address, command: "redo" }, saved)).toMatchObject({
        status: "nothing_to_redo",
      });
      expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
        control: "undo",
      });
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});
