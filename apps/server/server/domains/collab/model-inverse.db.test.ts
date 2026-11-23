/**
 * Strict model stacks, immutable history and bounded receipts.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - card-target eligibility for model inverses and bounded receipt context (kb/wiki/architecture/collaboration/turn-receipts.md#reversal-availability-is-the-servers)
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createDrizzleDocumentCommands } from "./adapters/drizzle-document-commands.js";
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
import { replacedText, writerEdit } from "./test-support/live-room-text.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

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
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Azure.\n\nBlue.\n");
        if (schedule === "count") {
          expect(await write(3)).toMatchObject({ status: "success" });
          expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
        } else {
          for (const text of ["Silver", "Gold", "Beta"]) {
            expect(await write()).toMatchObject({ status: "success" });
            expect(await harness.liveMarkdown(ALPHA_ID)).toBe(`Alpha ${text}.\n\nBlue.\n`);
          }
        }
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      } finally {
        await harness.dispose();
      }
    },
  );
  it("two-edit undo", async () => {
    const { harness, view, context, responseId } = await fixture();
    try {
      const core = view.collab.agentEdit();
      const address = { documentId: ALPHA_ID, file: "alpha.md" };
      const initial = context;
      await core.read(address, initial);
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gold" }, initial);
      await core.write(
        { ...address, command: "replace", find: "Gold", content: "Silver" },
        initial,
      );
      const prose = () => harness.liveMarkdown(ALPHA_ID);
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

it("model undo of an edit the writer retyped is refused and leaves the writer's text", async () => {
  const { harness, view, context } = await fixture();
  try {
    const core = view.collab.agentEdit();
    const command = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.write({ ...command, command: "replace", find: "Beta", content: "Gamma" }, context);
    // The writer retypes the model's word: none of what it put in is left (design §2's Undo rule).
    await writerEdit(view.rooms, ALPHA_ID, (blocks) => replacedText(blocks, "Gamma", "Red"));
    await core.read({ ...command, format: "edits" }, context);
    expect(await core.write({ ...command, command: "undo" }, context)).toMatchObject({
      status: "cant_undo_changed",
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Red.\n\nBlue.\n");
  } finally {
    await harness.dispose();
  }
});
