/** Card partial inverses and writer text preservation. */
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { createTestDocumentRemoval } from "../../test-support/document-removal.js";
import { testFileGrant } from "../../test-support/file-grants.js";
import { lockDocuments } from "../context/tree/node-rows.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { reviewDriver } from "./test-support/draft-review-requests.js";
import { draftContent } from "./test-support/draft-store-seam.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
describe("forward card inverse", () => {
  it.each(
    ["insert", "delete", "replace"].flatMap((kind) =>
      ["pending", "applied", "mixed"].map((placement) => ({ kind, placement })),
    ),
  )("$kind $placement Undo/Redo twice then Apply keeps exact bytes", async ({
    kind,
    placement,
  }) => {
    const { harness, view, responseId, context } = await fixture();
    const review = reviewDriver(view.collab.draftReview);
    try {
      const changes =
        kind === "insert"
          ? [
              ["Beta", " Gamma"],
              ["Blue", " Silver"],
            ]
          : [
              ["Beta", kind === "delete" ? "" : "Gamma"],
              ["Blue", kind === "delete" ? "" : "Silver"],
            ];
      for (const [index, [find, content]] of changes.entries())
        expect(
          await view.collab.agentEdit().write(
            {
              command: kind === "insert" ? "insert" : "replace",
              documentId: ALPHA_ID,
              file: "alpha.md",
              ...(find ? { find } : {}),
              content,
              tool_use_id: `part-${index}`,
            },
            context,
          ),
        ).toMatchObject({ status: "success", phase: "staged" });
      await harness.commit(responseId);
      const [documentDraft] = await db
        .select()
        .from(schema.documentDrafts)
        .where(
          and(
            eq(schema.documentDrafts.documentId, ALPHA_ID),
            eq(schema.documentDrafts.kind, "work_draft"),
          ),
        );
      const original = "Alpha Beta.\n\nBlue.\n";
      const edited =
        kind === "insert"
          ? "Alpha Beta Gamma.\n\nBlue Silver.\n"
          : kind === "delete"
            ? "Alpha .\n\n.\n"
            : "Alpha Gamma.\n\nSilver.\n";
      expect(await view.draftMarkdown(documentDraft.id)).toBe(edited);
      if (placement === "applied")
        expect(await review.applyItem(ALPHA_ID)).toMatchObject({ status: "applied" });
      if (placement === "mixed") {
        const preview = await review.activePreview(ALPHA_ID);
        expect(
          await review.applyChanges(ALPHA_ID, preview, [preview.operations[0].operationId]),
        ).toMatchObject({ status: "applied" });
      }
      const mixedLive = await harness.liveMarkdown(ALPHA_ID);
      for (const direction of ["undo", "redo", "undo", "redo"] as const) {
        expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
          control: direction,
        });
        const outcome = await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction,
          actor: { type: "user", userId: USER_ID },
        });
        expect(outcome).toMatchObject({
          status: "reversed",
          acceptedParts: 2,
          skips: [],
          documents: [
            {
              destination:
                placement === "applied"
                  ? { kind: "live" }
                  : { kind: "draft", draftId: documentDraft.id },
            },
          ],
        });
        const inverseParts = await db
          .select({ update: schema.documentEditParts.update })
          .from(schema.documentEditParts)
          .innerJoin(
            schema.documentEdits,
            eq(schema.documentEditParts.editId, schema.documentEdits.id),
          )
          .where(inArray(schema.documentEdits.kind, ["undo", "redo"]));
        for (const { update } of inverseParts) {
          const structs = Y.decodeUpdate(update).structs;
          // Pure inverse deletions have no inserted structs; every authored struct otherwise shares its part client.
          expect(new Set(structs.map((item) => item.id.client)).size).toBeLessThanOrEqual(1);
          for (const item of structs)
            if (
              item instanceof Y.Item &&
              (item.parent as unknown) === "__meridian_provenance_targets_v2"
            ) {
              expect(item.origin).toBeNull();
              expect(item.rightOrigin).toBeNull();
            }
        }

        expect(
          placement === "applied"
            ? await harness.liveMarkdown(ALPHA_ID)
            : await view.draftMarkdown(documentDraft.id),
        ).toBe(direction === "undo" ? original : edited);
        if (placement === "mixed") expect(await harness.liveMarkdown(ALPHA_ID)).toBe(mixedLive);
      }
      if (placement !== "applied")
        expect(await review.applyItem(ALPHA_ID)).toMatchObject({ status: "applied" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe(edited);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

it("Discard of the mixed document's Undo change reactivates its applied part", async () => {
  const { harness, view, responseId, context } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
  try {
    for (const [find, content] of [
      ["Beta", "Gamma"],
      ["Blue", "Silver"],
    ])
      expect(
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
        ),
      ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    const preview = await review.activePreview(ALPHA_ID);
    const gamma = preview.operations.find((operation) => operation.afterExcerpt === "Gamma");
    if (!gamma) throw new Error("Missing Gamma change");
    expect(await review.applyChanges(ALPHA_ID, preview, [gamma.operationId])).toMatchObject({
      status: "applied",
    });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    const inverse = await review.activePreview(ALPHA_ID);
    expect(inverse.operations).toHaveLength(1);
    expect(await review.discardChanges(ALPHA_ID, inverse)).toMatchObject({ status: "discarded" });
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "partial", acceptedParts: 1 });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("a tombstoned draft document with released storage does not stop another document's receipt from offering Undo", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    const betaContext = {
      ...context,
      grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }, BETA_ID),
    };
    await view.collab.agentEdit().read(
      { file: "beta.md", documentId: BETA_ID },
      {
        ...betaContext,
        responseIdentity: undefined,
      },
    );
    for (const [documentId, file, ctx] of [
      [ALPHA_ID, "alpha.md", context],
      [BETA_ID, "beta.md", betaContext],
    ] as const)
      expect(
        await view.collab
          .agentEdit()
          .write(
            { command: "insert", documentId, file, content: "Agent.", tool_use_id: file },
            ctx,
          ),
      ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    // What Discard of a draft-created document leaves: tombstoned row, released storage, edit rows kept.
    await runInDrizzleTransaction(db, async () => {
      await lockDocuments(db, [BETA_ID]);
      await createTestDocumentRemoval(db).remove({
        documentIds: [BETA_ID],
        reason: "discarded",
        cause: "repair",
      });
    });
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("typing inside restored text leaves Redo unavailable and does not delete the writer's word", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "",
          tool_use_id: "delete",
        },
        context,
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(
        and(
          eq(schema.documentDrafts.documentId, ALPHA_ID),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, await draftContent(db, documentDraft.id));
      doc.clientID = allocateDocumentClient(doc);
      const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      const updates = captureMutationUpdates(doc, () => text.insert(8, "!"));
      await view.draftCoordinator.commitWriterUpdate({
        draftId: documentDraft.id,
        expectedGeneration: documentDraft.generation,
        updateData: Y.mergeUpdates(updates),
        actorUserId: USER_ID,
        roomDocument: doc,
      });
    } finally {
      doc.destroy();
    }
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "view_change",
      skips: [{ before: "Beta", reason: "Stayed as you edited it" }],
    });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "expired", acceptedParts: 0 });
    expect(await view.draftMarkdown(documentDraft.id)).toBe("Alpha Be!ta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
