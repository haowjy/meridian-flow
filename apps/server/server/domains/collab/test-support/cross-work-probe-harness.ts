/** Real-adapter fixture orchestration for the split cross-Work merge probe. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import type { createHarness } from "./change-trail-postgres-harness.js";
import {
  ALPHA_ID,
  PROJECT_ID,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./change-trail-postgres-harness.js";

type CrossWorkProbeFixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;

export const WORK_B_ID = "00000000-0000-4000-8000-000000000820" as WorkId;
export const THREAD_B_ID = "00000000-0000-4000-8000-000000000821" as ThreadId;
export const TURN_B_ID = "00000000-0000-4000-8000-000000000822" as TurnId;

export type CrossWorkProbeResult = {
  case: "manual" | "auto";
  aApply: {
    status: string;
    liveOriginTypes: string[];
  };
  bApply: {
    status: string;
  };
  manuscript: {
    beforeAApply: string;
    afterAApply: string;
    beforeBApply: string;
    afterBApply: string;
  };
  approvedTextSurvived: boolean;
  protection: {
    classification: "protected" | "ordinary";
    capturedBodies: string[];
    trailChanges: unknown[];
    notices: unknown[];
    deliveredEvents: unknown[];
  };
  echo: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function serializable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, candidate) =>
      typeof candidate === "bigint" ? candidate.toString() : candidate,
    ),
  );
}

function serializeMarkdown(fixture: CrossWorkProbeFixture, doc: Y.Doc): string {
  return fixture.markupCodec.serialize(fixture.model.projectBlocks(toDocHandle(doc)));
}

export async function runCrossWorkProbe(
  fixture: CrossWorkProbeFixture,
  probeCase: "manual" | "auto",
): Promise<CrossWorkProbeResult> {
  const {
    db,
    schema,
    persistence,
    liveCoordinator,
    collab,
    branchStore,
    branchCoordinator,
    realBranchPush,
    trailDelivery,
    model,
    markupCodec,
    deliveredEvents,
  } = fixture;
  await db.insert(schema.works).values({
    id: WORK_B_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Work B",
    aiWriteMode: "draft",
  });
  await db.insert(schema.threads).values({
    id: THREAD_B_ID,
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    title: "Work B primary chat",
    kind: "primary",
    status: "active",
  });
  await db.insert(schema.turns).values({
    id: TURN_B_ID,
    threadId: THREAD_B_ID,
    role: "assistant",
    status: "complete",
  });
  await db.insert(schema.threadWorks).values({
    threadId: THREAD_B_ID,
    workId: WORK_B_ID,
    projectId: PROJECT_ID,
    isPrimary: true,
  });

  await persistence.lifecycle.ensureDocument(ALPHA_ID);
  await liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
    const before = Y.encodeStateVector(doc);
    model.insertBlocks(toDocHandle(doc), null, markupCodec.parse("Shared opening."));
    await persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
      origin: "system",
      seq: 0,
    });
  });
  const contextA = {
    sessionId: THREAD_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    responseId: undefined,
  };
  const contextB = {
    sessionId: THREAD_B_ID,
    threadId: THREAD_B_ID,
    turnId: TURN_B_ID,
    responseId: undefined,
  };
  await collab
    .agentEdit()
    .write({ command: "read", file: "alpha.md", documentId: ALPHA_ID }, contextA);
  await collab
    .agentEdit()
    .write({ command: "read", file: "alpha.md", documentId: ALPHA_ID }, contextB);

  const branchA = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_ID);
  const branchB = await branchStore.resolveWorkDraftBranchForThread(ALPHA_ID, THREAD_B_ID);
  const beforeAApply = await liveCoordinator.withDocument(ALPHA_ID, async (doc) =>
    serializeMarkdown(fixture, doc),
  );
  try {
    if (probeCase === "manual") {
      const bDoomed = model.getBlocks(toDocHandle(branchB.doc))[0];
      if (!bDoomed) throw new Error("Work B has no stale block to replace");
      model.deleteBlock(toDocHandle(branchB.doc), bDoomed);
      model.insertBlocks(
        toDocHandle(branchB.doc),
        null,
        markupCodec.parse("Work B stale replacement."),
      );
      const bCommitted = await branchCoordinator.commitSyncFromDoc({
        branchId: branchB.branchId,
        sourceDoc: branchB.doc,
        expectedGeneration: branchB.generation,
        source: "agent",
        actorUserId: null,
        threadId: THREAD_B_ID,
        turnId: TURN_B_ID,
        wId: null,
        updateMeta: null,
      });
      if (!bCommitted) throw new Error("Work B stale edit did not commit");
    }

    const aBlock = model.getBlocks(toDocHandle(branchA.doc))[0];
    if (!aBlock) throw new Error("Work A has no block to edit");
    model.applyTextEdit(
      toDocHandle(branchA.doc),
      aBlock,
      { from: "Shared opening.".length, to: "Shared opening.".length },
      " Writer-approved Work A text.",
    );
    const aCommitted = await branchCoordinator.commitSyncFromDoc({
      branchId: branchA.branchId,
      sourceDoc: branchA.doc,
      expectedGeneration: branchA.generation,
      source: "agent",
      actorUserId: null,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      wId: null,
      updateMeta: null,
    });
    if (!aCommitted) throw new Error("Work A reviewed edit did not commit");
  } finally {
    branchA.doc.destroy();
    branchB.doc.destroy();
  }

  const aResult = await realBranchPush.pushToLive({
    branchId: branchA.branchId,
    pushedByUserId: USER_ID as never,
  });
  const afterAApply = await liveCoordinator.withDocument(ALPHA_ID, async (doc) =>
    serializeMarkdown(fixture, doc),
  );
  const liveOriginTypes = (
    await db
      .select({ originType: schema.documentYjsUpdates.originType })
      .from(schema.documentYjsUpdates)
      .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID))
  ).flatMap((row) => (row.originType ? [row.originType] : []));

  const echo =
    probeCase === "manual"
      ? serializable(
          await collab.agentEdit().write(
            {
              command: "insert",
              file: "alpha.md",
              documentId: ALPHA_ID,
              content: "Work B echo probe.",
            },
            contextB,
          ),
        )
      : await (async () => {
          const writeResult = await collab.agentEdit().write(
            {
              command: "create",
              file: "alpha.md",
              documentId: ALPHA_ID,
              content: "Work B stale replacement.",
              overwrite: true,
            },
            { ...contextB, createdDocument: false },
          );
          return serializable(writeResult);
        })();
  const beforeBApply = await liveCoordinator.withDocument(ALPHA_ID, async (doc) =>
    serializeMarkdown(fixture, doc),
  );
  const reviewedPreview =
    probeCase === "manual"
      ? await collab.draftReview.preview({
          projectId: PROJECT_ID,
          workId: WORK_B_ID,
          documentId: ALPHA_ID,
        })
      : null;
  const bResult =
    reviewedPreview?.status === "active"
      ? await collab.draftReview.accept({
          projectId: PROJECT_ID,
          workId: WORK_B_ID,
          documentId: ALPHA_ID,
          branchId: branchB.branchId,
          userId: USER_ID as never,
        })
      : await realBranchPush.pushToLive({
          branchId: branchB.branchId,
          pushedByUserId: USER_ID as never,
        });
  const afterBApply = await liveCoordinator.withDocument(ALPHA_ID, async (doc) =>
    serializeMarkdown(fixture, doc),
  );
  await trailDelivery.drain();

  const bTrailIds = new Set(
    (await db.select().from(schema.changeTrailShells))
      .filter((row) => row.threadId === THREAD_B_ID)
      .map((row) => row.id),
  );
  const detailRows = (await db.select().from(schema.changeTrailDocumentDetails)).filter((row) =>
    bTrailIds.has(row.trailId),
  );
  const trailChanges = detailRows.flatMap((row) => (Array.isArray(row.changes) ? row.changes : []));
  const capturedBodies = trailChanges.flatMap((change) => {
    const beforeText = asRecord(change).beforeText;
    if (typeof beforeText !== "string") return [];
    const separator = beforeText.indexOf("|");
    return [separator < 0 ? beforeText : beforeText.slice(separator + 1)];
  });
  return {
    case: probeCase,
    aApply: {
      status: aResult.status,
      liveOriginTypes,
    },
    bApply: {
      status: bResult.status,
    },
    manuscript: { beforeAApply, afterAApply, beforeBApply, afterBApply },
    approvedTextSurvived: afterBApply.includes("Writer-approved Work A text."),
    protection: {
      classification: "ordinary",
      capturedBodies: [...new Set(capturedBodies)],
      trailChanges: serializable(trailChanges) as unknown[],
      notices: serializable(await db.select().from(schema.pendingNotices)) as unknown[],
      deliveredEvents: serializable(
        deliveredEvents.filter(
          (event) => asRecord(event).threadId === (THREAD_B_ID as unknown as string),
        ),
      ) as unknown[],
    },
    echo,
  };
}
