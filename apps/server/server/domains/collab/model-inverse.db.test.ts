/** Model `revert`: immutable history, the current destination, partial reverts and bounded receipts. */
import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
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

const address = { documentId: ALPHA_ID, file: "alpha.md" };

/** A writer's browser edit lands in the draft: `text.insert(8, "!")` in its first paragraph. */
async function writerTypes(view: Awaited<ReturnType<typeof fixture>>["view"], branchId: string) {
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
      updateData: Y.mergeUpdates(updates),
      actorUserId: USER_ID,
      roomDocument: doc,
    });
  } finally {
    doc.destroy();
  }
}

const hasEffect = async (branchId: string) =>
  (
    await db
      .select({ hasEffect: schema.documentBranches.hasEffect })
      .from(schema.documentBranches)
      .where(eq(schema.documentBranches.id, branchId))
  )[0]?.hasEffect;

describe("model revert", () => {
  // Risk: a revert in a live reply writes the draft, or the model has no way to take back an applied edit.
  it("reverts in the live version when the chat writes live", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const liveContext = { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) };
      const core = view.collab.agentEdit();
      await core.read(address, { ...liveContext, responseIdentity: undefined });
      expect(
        await core.write(
          { ...address, command: "replace", find: "Beta", content: "Gamma" },
          liveContext,
        ),
      ).toMatchObject({ status: "success" });
      await view.collab.finalizeResponseCommit(
        { providerResponseId: responseId, editScopeId: responseId },
        { threadId: THREAD_ID, turnId: TURN_ID },
      );
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
      const turnId = randomUUID();
      const nextResponse = randomUUID();
      await db.insert(schema.turns).values({
        id: turnId,
        threadId: THREAD_ID,
        parentTurnId: TURN_ID,
        position: 2,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.modelResponses).values({
        id: nextResponse,
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
          { ...address, command: "revert", edit: "w1" },
          {
            ...liveContext,
            turnId,
            responseIdentity: { providerResponseId: nextResponse, editScopeId: nextResponse },
          },
        ),
      ).toMatchObject({ status: "success" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  // Risk: a revert of a draft edit bypasses the review: it must land in the draft and leave `has_effect`
  // equal to "the draft differs from its base", not remain set after the text went back to the base.
  it("lands a draft revert in the draft and leaves has_effect equal to draft versus base", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      await core.read(address, context);
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gamma" }, context);
      await harness.commit(responseId);
      const branchId = await draftBranchId(db, ALPHA_ID);
      expect(await hasEffect(branchId)).toBe(true);
      const next = {
        ...context,
        responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
      };
      expect(
        await core.write(
          { ...address, command: "revert", edit: "w1", tool_use_id: "revert" },
          next,
        ),
      ).toMatchObject({ status: "success", writeId: "w2" });
      expect(await view.draftMarkdown(branchId)).toBe("Alpha Beta.\n\nBlue.\n");
      expect(await hasEffect(branchId)).toBe(false);
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  // Risk: reverting an edit the writer already applied silently rewrites live, skipping the review.
  it("writes the revert of an applied edit into the draft, as a change the writer applies", async () => {
    const { harness, view, context, responseId } = await fixture();
    const review = reviewDriver(view.collab.draftReview);
    try {
      const core = view.collab.agentEdit();
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gamma" }, context);
      await harness.commit(responseId);
      const branchId = await draftBranchId(db, ALPHA_ID);
      await review.applyItem(ALPHA_ID);
      expect(
        await core.write(
          { ...address, command: "revert", edit: "w1", tool_use_id: "revert" },
          context,
        ),
      ).toMatchObject({ status: "success", writeId: "w2" });
      expect(await view.draftMarkdown(branchId)).toBe("Alpha Beta.\n\nBlue.\n");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  // Risk: a revert undoes text the writer edited since, or reaches a draft edit from the live version.
  it("refuses an edit the writer changed since, and a draft edit from live, leaving content untouched", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gamma" }, context);
      await harness.commit(responseId);
      const branchId = await draftBranchId(db, ALPHA_ID);
      const liveContext = {
        ...context,
        responseIdentity: undefined,
        grant: testFileGrant({ kind: "live" }, ALPHA_ID),
      };
      await core.read({ ...address, format: "edits" }, liveContext);
      expect(
        await core.write({ ...address, command: "revert", edit: "w1" }, liveContext),
      ).toMatchObject({ status: "nothing_to_revert" });
      await core.read({ ...address, format: "edits" }, context);
      await writerTypes(view, branchId);
      expect(
        await core.write({ ...address, command: "revert", edit: "w1" }, context),
      ).toMatchObject({
        status: "nothing_to_revert",
      });
      expect(await view.draftMarkdown(branchId)).toBe("Alpha Ga!mma.\n\nBlue.\n");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  // D15. Risk: one touched block makes the whole multi-block edit unrevertable, or the revert undoes
  // the block the writer edited.
  it("reverts the blocks of a multipart edit the writer left alone and reports the rest", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      await core.read(address, context);
      expect(
        await core.write(
          { ...address, command: "replace", in: [1, 2], content: "Alpha Gamma.\n\nSilver." },
          context,
        ),
      ).toMatchObject({ status: "success", writeId: "w1" });
      await harness.commit(responseId);
      const branchId = await draftBranchId(db, ALPHA_ID);
      await writerTypes(view, branchId);
      const edits = await core.read({ ...address, format: "edits" }, context);
      expect(edits.result.message).toContain("changed");
      expect(edits.result.message).toContain("revert 1 of 2");
      expect(await view.draftMarkdown(branchId)).toBe("Alpha Ga!mma.\n\nSilver.\n");
      const reverted = await core.write({ ...address, command: "revert", edit: "w1" }, context);
      expect(reverted).toMatchObject({ status: "success", writeId: "w2" });
      expect(reverted.result.message).toContain("1 of 2 parts");
      expect(reverted.result.message).toContain("not reverted");
      expect(await view.draftMarkdown(branchId)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  // Risk: the edits page re-derives state from mutable data, or pages shift under a new revert.
  it("pages immutable edits, twenty at a time, and a new revert takes a fresh handle", async () => {
    const { harness, view, context, responseId } = await fixture();
    const review = reviewDriver(view.collab.draftReview);
    try {
      const core = view.collab.agentEdit();
      let previous = "Beta";
      for (let n = 1; n <= 25; n++) {
        expect(
          await core.write(
            { ...address, command: "replace", find: previous, content: `Text${n}` },
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
      const lines = (message?: string) =>
        message?.split("\n").filter((line) => /^w\d+ {2}/.test(line));
      const page = await core.read({ ...address, format: "edits" }, context);
      expect(lines(page.result.message)).toHaveLength(20);
      expect(page.result.message).toContain('w25  this turn  pending  "Text24" → "Text25"  revert');
      expect(page.result.message).toContain("more: before w6");
      const second = await core.read({ ...address, format: "edits", before: "w6" }, context);
      expect(lines(second.result.message)).toHaveLength(5);
      expect(second.result.message).toContain('w1  this turn  live  "Beta" → "Text1"');
      expect(
        await core.write({ ...address, command: "revert", edit: "w25" }, context),
      ).toMatchObject({ status: "success", writeId: "w26" });
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });

  // Risk: a revert's receipt echoes the whole document, flooding the model's context.
  it("echoes only changed blocks and their immediate context", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      await harness.seedWriterDocument(
        ["Alpha Beta.", "Blue.", ...Array.from({ length: 10 }, (_, n) => `Far ${n}.`)].join("\n\n"),
        responseId,
      );
      const core = view.collab.agentEdit();
      await core.read(address, context);
      expect(
        await core.write(
          { ...address, command: "replace", find: "Beta", content: "Gamma" },
          context,
        ),
      ).toMatchObject({ status: "success" });
      await harness.commit(responseId);
      const result = await core.write({ ...address, command: "revert", edit: "w1" }, context);
      expect(result.status).toBe("success");
      expect(JSON.stringify(result.result)).toContain("Alpha Beta.");
      expect(JSON.stringify(result.result)).not.toContain("Far 9.");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});
