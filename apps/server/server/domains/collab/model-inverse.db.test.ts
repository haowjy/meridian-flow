/** Strict model stacks, immutable history and bounded receipts. */
import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createAllowAllFileAccess } from "../file-policy/index.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
import { createTurnLiveLineageReadModel } from "./domain/turn-live-lineage.js";
import { createTurnReversalService } from "./domain/turn-reversal-service.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";
import { draftBranchId, inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
describe("model document stack", () => {
  it("authorizes live model revert through card Undo and Redo, without treating stack actions as card targets", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const resolveDocumentUri = async (documentId: string) =>
        documentId === ALPHA_ID ? "manuscript/alpha.md" : null;
      const lineage = createTurnLiveLineageReadModel({
        store: createDrizzleTurnLiveLineageStore(db),
        resolveDocumentUri,
      });
      const card = createTurnReversalService({
        turnInverse: { reverseTurn: view.collab.reverseTurn },
        resolveDocumentUri,
        listEditedDocumentsForTurn: lineage.listEditedDocumentsForTurn,
        fileAccess: createAllowAllFileAccess(),
        threadContext: { requireThreadOwner: async () => ({ projectId: PROJECT_ID }) },
      });
      const liveContext = { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) };
      const core = view.collab.agentEdit();
      await core.read(
        { file: "alpha.md", documentId: ALPHA_ID },
        { ...liveContext, responseIdentity: undefined },
      );
      expect(
        await core.write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find: "Beta",
            content: "Gamma",
            tool_use_id: "original-live",
          },
          liveContext,
        ),
      ).toMatchObject({ status: "success" });
      await view.collab.finalizeResponseCommit(
        { providerResponseId: responseId, editScopeId: responseId },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      let position = 2;
      const command = async (kind: "undo" | "redo" | "revert") => {
        const turnId = randomUUID();
        const responseId = randomUUID();
        await db.insert(schema.turns).values({
          id: turnId,
          threadId: THREAD_ID,
          parentTurnId: TURN_ID,
          position: position++,
          role: "assistant",
          origin: "assistant",
          status: "complete",
        });
        await db.insert(schema.modelResponses).values({
          id: responseId,
          turnId,
          sequence: 1,
          provider: "mock",
          model: "mock",
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        expect(
          await core.write(
            {
              ...(kind === "revert" ? { command: kind, edit: "w1" } : { command: kind }),
              documentId: ALPHA_ID,
              file: "alpha.md",
              tool_use_id: `model-${kind}`,
            },
            {
              ...liveContext,
              turnId,
              responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
            },
          ),
        ).toMatchObject({ status: "success" });
        return turnId;
      };
      // Stack actions change the original edit's state, but are not new card targets.
      for (const kind of ["undo", "redo"] as const) {
        const turnId = await command(kind);
        const text = await harness.liveMarkdown(ALPHA_ID);
        expect(await view.collab.getTurnReceiptChip(THREAD_ID, turnId)).toBeNull();
        for (const direction of ["undo", "redo"] as const) {
          expect(
            await card.reverseThreadContext({
              threadId: THREAD_ID,
              turnId,
              direction,
              userId: USER_ID,
            }),
          ).toMatchObject({ status: direction === "undo" ? "nothing_to_undo" : "nothing_to_redo" });
        }
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe(text);
      }
      const turnId = await command("revert");
      expect(await view.collab.getTurnReceiptChip(THREAD_ID, turnId)).toMatchObject({
        control: "undo",
      });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      expect(
        await card.reverseThreadContext({
          threadId: THREAD_ID,
          turnId,
          direction: "undo",
          userId: USER_ID,
        }),
      ).toMatchObject({ status: "reversed" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
      expect(
        await card.reverseThreadContext({
          threadId: THREAD_ID,
          turnId,
          direction: "redo",
          userId: USER_ID,
        }),
      ).toMatchObject({ status: "reversed" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each([
    "stepwise",
    "count",
  ] as const)("overlapping replacements compose %s undo and redo", async (schedule) => {
    const { harness, view, context, responseId } = await fixture();
    try {
      for (const [index, [find, content]] of [
        ["Beta", "Gold"],
        ["Gold", "Silver"],
        ["Silver", "Azure"],
      ].entries())
        expect(
          await view.collab.agentEdit().write(
            {
              command: "replace",
              documentId: ALPHA_ID,
              file: "alpha.md",
              find,
              content,
              tool_use_id: `entry-${index}`,
            },
            context,
          ),
        ).toMatchObject({ status: "success", writeId: `w${index + 1}` });
      await harness.commit(responseId);
      const branchId = await draftBranchId(db, ALPHA_ID);
      let call = 0;
      const write = async (command: "undo" | "redo", count?: number) =>
        view.collab.agentEdit().write(
          {
            command,
            documentId: ALPHA_ID,
            file: "alpha.md",
            ...(count ? { count } : {}),
            tool_use_id: `inverse-${++call}`,
          },
          context,
        );
      expect(await write("undo", 4)).toMatchObject({ status: "insufficient_undo" });
      expect(await view.draftMarkdown(branchId)).toBe("Alpha Azure.\n\nBlue.\n");
      if (schedule === "count") {
        expect(await write("undo", 3)).toMatchObject({ status: "success" });
        expect(await view.draftMarkdown(branchId)).toBe("Alpha Beta.\n\nBlue.\n");
        expect(await write("redo", 3)).toMatchObject({ status: "success" });
      } else {
        for (const text of ["Silver", "Gold", "Beta"]) {
          expect(await write("undo")).toMatchObject({ status: "success" });
          expect(await view.draftMarkdown(branchId)).toBe(`Alpha ${text}.\n\nBlue.\n`);
        }
        expect(await write("redo")).toMatchObject({
          status: "success",
          result: { message: "redone: w1" },
        });
        expect(await view.draftMarkdown(branchId)).toBe("Alpha Gold.\n\nBlue.\n");
        expect(await write("redo", 2)).toMatchObject({ status: "success" });
      }
      expect(await view.draftMarkdown(branchId)).toBe("Alpha Azure.\n\nBlue.\n");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each([
    ["draft", "count"],
    ["live", "stepwise"],
    ["draft", "stepwise"],
    ["draft", "short"],
    ["draft", "rollback"],
  ] as const)("two-edit undo in %s supports %s redo", async (destination, schedule) => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      const address = { documentId: ALPHA_ID, file: "alpha.md" };
      const initial =
        destination === "live"
          ? { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) }
          : context;
      await core.read(address, initial);
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gold" }, initial);
      await core.write(
        { ...address, command: "replace", find: "Gold", content: "Silver" },
        initial,
      );
      await harness.commit(responseId);
      const branchId = await draftBranchId(db, ALPHA_ID);
      const prose = () =>
        destination === "live" ? harness.liveMarkdown(ALPHA_ID) : view.draftMarkdown(branchId);
      const responseIdentity = { providerResponseId: responseId, editScopeId: randomUUID() };
      const inverse = { ...initial, responseIdentity };
      const write = (command: "undo" | "redo", count = 1) =>
        core.write({ ...address, command, count }, inverse);
      expect(await write("undo", 2)).toMatchObject({
        status: "success",
        result: { message: "undone: w2, w1" },
      });
      expect(await prose()).toBe("Alpha Beta.\n\nBlue.\n");
      if (schedule === "rollback") {
        const actions = await db
          .select()
          .from(schema.documentEdits)
          .where(eq(schema.documentEdits.editScopeId, responseIdentity.editScopeId));
        expect(actions).toHaveLength(2);
        expect(new Set(actions.map((action) => action.actionId)).size).toBe(2);
        for (let attempt = 0; attempt < 2; attempt++) {
          await view.collab.finalizeResponseRollback(responseIdentity, {
            threadId: THREAD_ID,
            turnId: TURN_ID,
          });
          expect(await prose()).toBe("Alpha Silver.\n\nBlue.\n");
        }
        expect(await write("redo")).toMatchObject({ status: "nothing_to_redo" });
        expect(await write("undo", 2)).toMatchObject({ status: "success" });
      } else if (schedule === "short") {
        expect(await write("redo", 3)).toMatchObject({
          status: "insufficient_redo",
          result: { message: expect.stringContaining("Only 2 edits to redo") },
        });
        expect(await prose()).toBe("Alpha Beta.\n\nBlue.\n");
        expect(await write("redo", 2)).toMatchObject({ status: "success" });
      } else if (schedule === "stepwise") {
        expect(await write("redo")).toMatchObject({
          status: "success",
          result: { message: "redone: w1" },
        });
        expect(await prose()).toBe("Alpha Gold.\n\nBlue.\n");
        expect(await write("redo")).toMatchObject({
          status: "success",
          result: { message: "redone: w2" },
        });
      } else {
        expect(await write("redo", 2)).toMatchObject({
          status: "success",
          result: { message: "redone: w1, w2" },
        });
      }
      expect(await prose()).toBe(
        schedule === "rollback" ? "Alpha Beta.\n\nBlue.\n" : "Alpha Silver.\n\nBlue.\n",
      );
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each([
    "applied",
    "discarded",
    "user undo",
  ] as const)("model refuses user-acted %s tops and reverts eligible parts", async (state) => {
    const { harness, view, context, responseId } = await fixture();
    const review = reviewDriver(view.collab.draftReview);
    try {
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "entry",
        },
        context,
      );
      await harness.commit(responseId);
      const branchId = await draftBranchId(db, ALPHA_ID);
      if (state === "applied") await review.applyItem(ALPHA_ID);
      if (state === "discarded") await review.discardItem(ALPHA_ID);
      if (state === "user undo")
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        });
      const edits = await view.collab
        .agentEdit()
        .read({ documentId: ALPHA_ID, file: "alpha.md", format: "edits" }, context);
      expect(edits).toMatchObject({ status: "success" });
      expect(edits.result.message).toContain(state === "user undo" ? "undone by the user" : state);
      const command = state === "user undo" ? "redo" : "undo";
      const undone = await view.collab
        .agentEdit()
        .write(
          { command, documentId: ALPHA_ID, file: "alpha.md", tool_use_id: "model-inverse" },
          context,
        );
      expect(undone.status).toBe(
        state === "user undo" ? "cant_redo_users_undo" : `cant_undo_${state}`,
      );
      if (state === "applied") {
        expect(
          await view.collab.agentEdit().write(
            {
              command: "revert",
              documentId: ALPHA_ID,
              file: "alpha.md",
              edit: "w1",
              tool_use_id: "revert",
            },
            context,
          ),
        ).toMatchObject({ status: "success", writeId: "w2" });
        expect(await view.draftMarkdown(branchId)).toBe("Alpha Beta.\n\nBlue.\n");
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
      }
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

it.each([
  "undo",
  "redo",
] as const)("model %s refuses changed and elsewhere without touching content", async (direction) => {
  const { harness, view, context, responseId } = await fixture();
  try {
    const core = view.collab.agentEdit();
    const command = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.write({ ...command, command: "replace", find: "Beta", content: "Gamma" }, context);
    await harness.commit(responseId);
    const branchId = await draftBranchId(db, ALPHA_ID);
    if (direction === "redo")
      expect(await core.write({ ...command, command: "undo" }, context)).toMatchObject({
        status: "success",
      });
    const liveContext = {
      ...context,
      responseIdentity: undefined,
      grant: testFileGrant({ kind: "live" }, ALPHA_ID),
    };
    await core.read({ ...command, format: "edits" }, liveContext);
    expect(await core.write({ ...command, command: direction }, liveContext)).toMatchObject({
      status: `cant_${direction}_elsewhere`,
    });
    await core.read({ ...command, format: "edits" }, context);
    const [branch] = await db
      .select()
      .from(schema.documentBranches)
      .where(eq(schema.documentBranches.id, branchId));
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
    const expected = direction === "undo" ? "Alpha Ga!mma.\n\nBlue.\n" : "Alpha Be!ta.\n\nBlue.\n";
    expect(await core.write({ ...command, command: direction }, context)).toMatchObject({
      status: `cant_${direction}_changed`,
    });
    expect(await core.write({ ...command, command: "revert", edit: "w1" }, context)).toMatchObject({
      status: "nothing_to_revert",
    });
    expect(await view.draftMarkdown(branchId)).toBe(expected);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each([
  "applied",
  "discarded",
] as const)("model cannot redo an undo the user %s", async (state) => {
  const { harness, view, context, responseId } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
  try {
    const core = view.collab.agentEdit(),
      command = { documentId: ALPHA_ID, file: "alpha.md" };
    // A second edit keeps the item reviewable: an item whose edits all cancel is not listed.
    await core.write({ ...command, command: "replace", find: "Beta", content: "Gamma" }, context);
    await core.write({ ...command, command: "replace", find: "Blue", content: "Silver" }, context);
    await harness.commit(responseId);
    expect(await core.write({ ...command, command: "undo" }, context)).toMatchObject({
      status: "success",
    });
    if (state === "applied") await review.applyItem(ALPHA_ID);
    else await review.discardItem(ALPHA_ID);
    expect(await core.write({ ...command, command: "redo" }, context)).toMatchObject({
      status: `cant_redo_${state}`,
    });
    const edits = await core.read({ ...command, format: "edits" }, context);
    expect(edits.result.message).not.toMatch(/ {2}redo(?:\n|$)/);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
      state === "applied" ? "Alpha Gamma.\n\nBlue.\n" : "Alpha Beta.\n\nBlue.\n",
    );
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("model edit pages decode immutable parts and a new revert clears redo in the current destination", async () => {
  const { harness, view, context, responseId } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
  try {
    const core = view.collab.agentEdit(),
      command = { documentId: ALPHA_ID, file: "alpha.md" };
    let previous = "Beta";
    for (let n = 1; n <= 25; n++) {
      expect(
        await core.write(
          { ...command, command: "replace", find: previous, content: `Text${n}` },
          context,
        ),
      ).toMatchObject({ status: "success", writeId: `w${n}` });
      previous = `Text${n}`;
      if (n === 1) {
        await harness.commit(responseId);
        await review.applyItem(ALPHA_ID);
        context.responseIdentity = { providerResponseId: responseId, editScopeId: randomUUID() };
      }
    }
    await view.collab.finalizeResponseCommit(context.responseIdentity, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const page = await core.read({ ...command, format: "edits" }, context);
    expect(page.result.message?.split("\n").filter((line) => /^w\d+ {2}/.test(line))).toHaveLength(
      20,
    );
    expect(page.result.message).toContain('w25  this turn  pending  "Text24" → "Text25"  undo');
    expect(page.result.message).toContain("more: before w6");
    const second = await core.read({ ...command, format: "edits", before: "w6" }, context);
    expect(
      second.result.message?.split("\n").filter((line) => /^w\d+ {2}/.test(line)),
    ).toHaveLength(5);
    expect(second.result.message).toContain('w1  this turn  applied  "Beta" → "Text1"');
    expect(await core.write({ ...command, command: "undo" }, context)).toMatchObject({
      status: "success",
    });
    expect(await core.write({ ...command, command: "revert", edit: "w24" }, context)).toMatchObject(
      { status: "success", writeId: "w27" },
    );
    expect(await core.write({ ...command, command: "redo" }, context)).toMatchObject({
      status: "nothing_to_redo",
    });
    const branchId = await draftBranchId(db, ALPHA_ID);
    expect(await view.draftMarkdown(branchId)).toBe("Alpha Text23.\n\nBlue.\n");
    const liveContext = {
      ...context,
      responseIdentity: undefined,
      grant: testFileGrant({ kind: "live" }, ALPHA_ID),
    };
    await core.read({ ...command, format: "edits" }, liveContext);
    expect(
      await core.write({ ...command, command: "revert", edit: "w23" }, liveContext),
    ).toMatchObject({ status: "nothing_to_revert" });
    await core.read({ ...command, format: "edits" }, context);
    await review.applyItem(ALPHA_ID);
    await core.read({ ...command, format: "edits" }, liveContext);
    expect(
      await core.write({ ...command, command: "revert", edit: "w23" }, liveContext),
    ).toMatchObject({ status: "success", writeId: "w28" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Text22.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each([
  "changed",
  "partly applied",
] as const)("a multipart %s top blocks undo but targeted revert preserves skipped content", async (state) => {
  const { harness, view, context, responseId } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
  try {
    const core = view.collab.agentEdit(),
      address = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.read(address, context);
    expect(
      await core.write(
        { ...address, command: "replace", in: [1, 2], content: "Alpha Gamma.\n\nSilver." },
        context,
      ),
    ).toMatchObject({ status: "success", writeId: "w1" });
    await harness.commit(responseId);
    const branchId = await draftBranchId(db, ALPHA_ID);
    if (state === "partly applied") {
      const preview = await review.activePreview(ALPHA_ID);
      await review.applyChanges(ALPHA_ID, preview, [preview.operations[0].operationId]);
    } else {
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.id, branchId));
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
    }
    const before = state === "changed" ? "Alpha Ga!mma.\n\nSilver.\n" : "Alpha Gamma.\n\nSilver.\n";
    const edits = await core.read({ ...address, format: "edits" }, context);
    expect(edits.result.message).toContain(
      state === "changed" ? "changed" : "partly applied (1 of 2)",
    );
    if (state === "changed") expect(edits.result.message).toContain("revert 1 of 2");
    expect(await core.write({ ...address, command: "undo" }, context)).toMatchObject({
      status: state === "changed" ? "cant_undo_changed" : "cant_undo_applied",
    });
    expect(await view.draftMarkdown(branchId)).toBe(before);
    expect(await core.write({ ...address, command: "revert", edit: "w1" }, context)).toMatchObject({
      status: "success",
      writeId: "w2",
    });
    expect(await view.draftMarkdown(branchId)).toBe(
      state === "changed" ? "Alpha Ga!mma.\n\nBlue.\n" : "Alpha Beta.\n\nBlue.\n",
    );
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("model inverse receipts echo only changed blocks and their immediate context", async () => {
  const { harness, view, context, responseId } = await fixture();
  try {
    await harness.seedWriterDocument(
      ["Alpha Beta.", "Blue.", ...Array.from({ length: 10 }, (_, n) => `Far ${n}.`)].join("\n\n"),
      responseId,
    );
    const core = view.collab.agentEdit(),
      address = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.read(address, context);
    expect(
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gamma" }, context),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    for (const command of ["undo", "redo"] as const) {
      const result = await core.write({ ...address, command }, context);
      expect(result.status).toBe("success");
      expect(JSON.stringify(result.result)).toContain(
        command === "undo" ? "Alpha Beta." : "Alpha Gamma.",
      );
      expect(JSON.stringify(result.result)).not.toContain("Far 9.");
    }
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
