/**
 * Strict model stacks, immutable history and bounded receipts.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - card-target eligibility for model inverses and bounded receipt context (kb/wiki/architecture/collaboration/turn-receipts.md#reversal-availability-is-the-servers)
 */
import { randomUUID } from "node:crypto";
import { REVIEW_BASE_FRAGMENT, readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import { applyTextEdit } from "@meridian/agent-edit/test-support";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient, buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createDrizzleDocumentCommands } from "./adapters/drizzle-document-commands.js";
import { createDrizzleDraftDispositionStore } from "./adapters/drizzle-draft-disposition.js";
import { createDrizzleReversalLocks } from "./adapters/drizzle-reversal-locks.js";
import { createDrizzleTurnLiveLineageStore } from "./adapters/drizzle-turn-live-lineage.js";
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
} from "./test-support/collab-postgres-harness.js";
import { recordApply } from "./test-support/draft-classification.js";
import { draftContent } from "./test-support/draft-store-seam.js";
import { inverseFixture, readDraftId } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
describe("model document stack", () => {
  it("authorizes live model revert through card Undo, without treating stack actions as card targets", async () => {
    const { harness, view, context } = await fixture();
    try {
      const resolveDocumentUri = async (documentId: string) =>
        documentId === ALPHA_ID ? "manuscript/alpha.md" : null;
      const card = createTurnReversalService({
        turnInverse: {
          reverseTurn: view.collab.reverseTurn,
          reversalOwners: view.collab.reversalOwners,
        },
        lockOwners: createDrizzleReversalLocks(db),
        resolveDocumentUri,
        listTurnTargets: createDrizzleTurnLiveLineageStore(db).listEditedDocumentIdsForTurn,
        commands: createDrizzleDocumentCommands(db),
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
      let position = 2;
      let editHandle = "e1";
      const command = async (kind: "undo" | "revert") => {
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
              ...(kind === "revert" ? { command: kind, edit: editHandle } : { command: kind }),
              documentId: ALPHA_ID,
              file: "alpha.md",
              tool_use_id: `model-${kind}`,
            },
            {
              ...liveContext,
              turnId,
              responseIdentity: { modelResponseId: responseId },
            },
          ),
        ).toMatchObject({ status: "success" });
        return turnId;
      };
      // Stack actions change the original edit's state, but are not new card targets.
      {
        const turnId = await command("undo");
        const text = await harness.liveMarkdown(ALPHA_ID);
        expect(await view.collab.getDocumentAndTreeChip(THREAD_ID, turnId)).toBeNull();
        expect(
          await card.reverseThreadContext({
            commandId: randomUUID(),
            threadId: THREAD_ID,
            turnId,
            userId: USER_ID,
          }),
        ).toMatchObject({ status: "nothing_to_undo" });
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe(text);
      }
      // The undone edit can't be reverted; the model writes it again, and reverts that.
      const again = await core.write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "written-again",
        },
        liveContext,
      );
      expect(again).toMatchObject({ status: "success" });
      editHandle = (again as { writeId: string }).writeId;
      const turnId = await command("revert");
      expect(await view.collab.getDocumentAndTreeChip(THREAD_ID, turnId)).toMatchObject({
        control: "undo",
      });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      expect(
        await card.reverseThreadContext({
          commandId: randomUUID(),
          threadId: THREAD_ID,
          turnId,
          userId: USER_ID,
        }),
      ).toMatchObject({ status: "reversed" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
    } finally {
      await harness.dispose();
    }
  });
  it.each(["stepwise", "count"] as const)(
    "overlapping replacements compose %s undo",
    async (schedule) => {
      const { harness, view, context } = await fixture();
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
          ).toMatchObject({ status: "success", writeId: `e${index + 1}` });
        const draftId = await readDraftId(db, ALPHA_ID);
        let call = 0;
        const write = async (count?: number) =>
          view.collab.agentEdit().write(
            {
              command: "undo",
              documentId: ALPHA_ID,
              file: "alpha.md",
              ...(count ? { count } : {}),
              tool_use_id: `inverse-${++call}`,
            },
            context,
          );
        expect(await write(4)).toMatchObject({ status: "insufficient_undo" });
        expect(await view.draftMarkdown(draftId)).toBe("Alpha Azure.\n\nBlue.\n");
        if (schedule === "count") {
          expect(await write(3)).toMatchObject({ status: "success" });
          expect(await view.draftMarkdown(draftId)).toBe("Alpha Beta.\n\nBlue.\n");
        } else {
          for (const text of ["Silver", "Gold", "Beta"]) {
            expect(await write()).toMatchObject({ status: "success" });
            expect(await view.draftMarkdown(draftId)).toBe(`Alpha ${text}.\n\nBlue.\n`);
          }
        }
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      } finally {
        await harness.dispose();
      }
    },
  );
  it("leaves text the writer applied to the manuscript, and says so", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      const address = { documentId: ALPHA_ID, file: "alpha.md" };
      await core.read(address, context);
      expect(
        await core.write(
          { ...address, command: "replace", find: "Beta", content: "Gamma" },
          context,
        ),
      ).toMatchObject({ status: "success", writeId: "e1" });
      const draftId = await readDraftId(db, ALPHA_ID);
      const pm = buildDocumentSchema();
      const applyDraft = async (liveText: string) => {
        const { doc, snapshot } = await view.draftCoordinator.copyDraft(draftId);
        try {
          doc.clientID = 1;
          doc.transact(() => {
            writeBlocks(
              doc.getXmlFragment(REVIEW_BASE_FRAGMENT),
              pm,
              readBlocks(doc.getXmlFragment("prosemirror"), pm),
            );
          });
          await db
            .update(schema.documentDrafts)
            .set({
              state: Buffer.from(Y.encodeStateAsUpdate(doc)),
              stateVector: Buffer.from(Y.encodeStateVector(doc)),
              revision: snapshot.revision + 1,
              checkpointRevision: snapshot.revision + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.documentDrafts.id, draftId));
          await view.draftCoordinator.deliverCommitted(draftId);
          await recordApply(db, {
            draftId,
            documentId: ALPHA_ID,
            accountId: USER_ID,
            projectId: PROJECT_ID,
            store: createDrizzleDraftDispositionStore(db),
          });
        } finally {
          doc.destroy();
        }
        await view.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
          const block = view.model.getBlocks(doc)[0];
          if (!block) throw new Error("live block missing");
          const before = Y.encodeStateVector(doc);
          applyTextEdit(block, { from: 0, to: view.model.getText(block).length }, liveText);
          const update = Y.encodeStateAsUpdate(doc, before);
          if (update.length)
            await view.persistence.journal.append(ALPHA_ID, update, { origin: "system", seq: 0 });
        });
      };

      // Text the writer applied is in the manuscript: the model's Undo does not take it back.
      const secondContext = {
        ...context,
        responseIdentity: { modelResponseId: responseId },
      };
      await applyDraft("Alpha Gamma.");
      await core.read(address, secondContext);
      expect(await core.read({ ...address, format: "edits" }, context)).toMatchObject({
        status: "success",
        result: { message: expect.stringMatching(/e1.*applied.*none/) },
      });
      expect(await core.write({ ...address, command: "undo" }, secondContext)).toMatchObject({
        status: "cant_undo_changed",
      });
      expect(await view.draftMarkdown(draftId)).toBe("Alpha Gamma.\n\nBlue.\n");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
    } finally {
      await harness.dispose();
    }
  });
  it.each(["live", "draft"] as const)("two-edit undo in %s", async (destination) => {
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
      const draftId = await readDraftId(db, ALPHA_ID);
      const prose = () =>
        destination === "live" ? harness.liveMarkdown(ALPHA_ID) : view.draftMarkdown(draftId);
      const responseIdentity = { modelResponseId: responseId };
      const inverse = { ...initial, responseIdentity };
      const write = (count: number) => core.write({ ...address, command: "undo", count }, inverse);
      expect(await write(2)).toMatchObject({
        status: "success",
        result: { message: "undone: e2, e1" },
      });
      expect(await prose()).toBe("Alpha Beta.\n\nBlue.\n");
    } finally {
      await harness.dispose();
    }
  });
});

it("model undo of an edit the writer typed inside is refused and leaves the draft as it is", async () => {
  const { harness, view, context } = await fixture();
  try {
    const core = view.collab.agentEdit();
    const command = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.write({ ...command, command: "replace", find: "Beta", content: "Gamma" }, context);
    const draftId = await readDraftId(db, ALPHA_ID);
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(eq(schema.documentDrafts.id, draftId));
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, await draftContent(db, documentDraft.id));
      doc.clientID = allocateDocumentClient(doc);
      const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      const updates = captureMutationUpdates(doc, () => text.insert(8, "!"));
      await view.draftCoordinator.commitWriterUpdate({
        draftId: documentDraft.id,
        updateData: Y.mergeUpdates(updates),
        actorUserId: USER_ID,
        roomDocument: doc,
      });
    } finally {
      doc.destroy();
    }
    const liveContext = {
      ...context,
      responseIdentity: undefined,
      grant: {
        ...testFileGrant({ kind: "live" }, ALPHA_ID),
        principal: context.grant.principal,
      },
    };
    await core.read({ ...command, format: "edits" }, liveContext);
    expect(await core.write({ ...command, command: "undo" }, liveContext)).toMatchObject({
      status: "cant_undo_changed",
    });
    expect(await view.draftMarkdown(draftId)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
  } finally {
    await harness.dispose();
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
    const result = await core.write({ ...address, command: "undo" }, context);
    expect(result.status).toBe("success");
    expect(JSON.stringify(result.result)).toContain("Alpha Beta.");
    expect(JSON.stringify(result.result)).not.toContain("Far 9.");
  } finally {
    await harness.dispose();
  }
});
