/** Snapshot-owned branch mutations and explicit preview-fenced request envelopes. */
import { randomUUID } from "node:crypto";
import type { DraftCommandId, DraftId, UserId, WorkId } from "@meridian/contracts";
import type { DraftCommandKind } from "@meridian/contracts/drafts";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { commandDigest, type DraftCommandEnvelope } from "../domain/draft-commands.js";
import {
  type createHarness,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./change-trail-postgres-harness.js";
import { captureHistoricalBranchRow } from "./historical-branch-row.js";

type Fixture = ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>;
export async function commitBranchEdit(
  fixture: Fixture,
  branchId: string,
  author: {
    source: "agent" | "writer";
    clientId?: number;
    threadId?: typeof THREAD_ID | null;
    toolCallId?: string;
  },
  mutate: (doc: Y.Doc) => void,
) {
  const staged = await fixture.branchCoordinator.readBranch(branchId, async (doc, snapshot) => {
    const clone = createCollabYDoc({ gc: false });
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
    return { clone, generation: snapshot.generation };
  });
  try {
    if (author.clientId !== undefined) staged.clone.clientID = author.clientId;
    mutate(staged.clone);
    await fixture.branchCoordinator.commitSegmentRows({
      branchId: branchId,
      sourceDoc: staged.clone,
      expectedGeneration: staged.generation,
      rows: [
        {
          branchId: branchId,
          updateData: await captureHistoricalBranchRow(
            fixture.branchCoordinator,
            branchId,
            staged.clone,
          ),
          source: author.source,
          actorUserId: author.source === "writer" ? USER_ID : null,
          threadId: author.threadId === undefined ? THREAD_ID : author.threadId,
          turnId: author.source === "agent" ? TURN_ID : null,
          wId: null,
          toolCallId: author.toolCallId ?? null,
          updateMeta: null,
        },
      ],
    });
  } finally {
    staged.clone.destroy();
  }
}

/** A fresh command envelope for facade-level suites; the route builds its own from the body. */
export function testEnvelope(input: {
  workId: WorkId;
  kind: DraftCommandKind;
  draftId: DraftId | null;
  userId?: UserId;
  commandId?: DraftCommandId;
  body?: unknown;
}): DraftCommandEnvelope {
  const accountId = input.userId ?? (USER_ID as UserId);
  return {
    commandId: input.commandId ?? (randomUUID() as DraftCommandId),
    workId: input.workId,
    accountId,
    kind: input.kind,
    draftId: input.draftId,
    digest: commandDigest({
      accountId,
      projectId: "",
      workId: input.workId,
      kind: input.kind,
      selectors: { draftId: input.draftId },
      body: input.body ?? null,
    }),
  };
}

/** The per-change selection a client sends after previewing, for the operations it clicked. */
export function fencedSelection(
  preview: {
    liveRevisionToken: string;
    draftRevisionToken: string;
    operations: readonly {
      operationId: string;
      partKey?: string;
      admissionToken: string;
      closureClassId: string;
    }[];
  },
  operationIds: string[],
) {
  const clicked = preview.operations.filter((op) => operationIds.includes(op.operationId));
  return {
    operationIds,
    memberPartKeys: clicked.flatMap((op) => (op.partKey ? [op.partKey] : [])),
    admissionTokens: [...new Set(clicked.map((op) => op.admissionToken))],
    closureClassIds: [...new Set(clicked.map((op) => op.closureClassId))],
    liveRevisionToken: preview.liveRevisionToken,
    draftRevisionToken: preview.draftRevisionToken,
  };
}
