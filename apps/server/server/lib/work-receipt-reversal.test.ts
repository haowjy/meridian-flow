/** Typed Work receipt reversal behavior and ordering.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Work reversal aggregation, transaction notices, and unchanged filtering
 */

import type { WorkId } from "@meridian/contracts/runtime";
import type { WorkReceipt } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkRepository } from "../domains/projects/index.js";
import { rebindThreadWork } from "../domains/threads/index.js";
import {
  combineWorkReversalOutcome,
  getTurnReceiptChip,
  reverseWorkReceipts,
} from "./work-receipt-reversal.js";

const THREAD_ID = "thread-1" as never;
const TURN_ID = "turn-1" as never;

function harness(receipts: WorkReceipt[]) {
  const works = createInMemoryWorkRepository();
  return {
    works,
    deps: {
      works,
      turns: { findById: async () => ({ id: TURN_ID, threadId: THREAD_ID }) as never },
      threads: {
        findById: async () =>
          ({
            id: THREAD_ID,
            userId: "user-1",
            projectId: "project-1",
            kind: "primary",
          }) as never,
      },
      workContextNotices: { workChanged: vi.fn(async () => {}) },
      transaction: works.transaction,
      stopThreads: vi.fn(async () => {}),
      documentSync: { getDocumentAndTreeChip: async () => null },
      blocks: {
        listByTurn: async () =>
          receipts.map((workReceipt) => ({
            content: { metadata: { workReceipt } },
          })) as never,
      },
    },
  };
}

function state(name: string, status: "active" | "archived" = "active") {
  return {
    name,
    goal: null,
    status: null,
    archived: status === "archived",
  } as const;
}

function persistedState(name: string, status: "active" | "archived" = "active") {
  return {
    name,
    goal: null,
    status: null,
    archivedAt: status === "archived" ? expect.any(String) : null,
  };
}

describe("Work receipt reversal", () => {
  it("aggregates successful and failed Work parts truthfully", () => {
    expect(
      combineWorkReversalOutcome({ status: "nothing_to_undo", documents: [] }, [
        {
          command: "restore",
          projectId: "project-1",
          workId: "w1" as never,
          name: "Arc",
          status: "reversed",
        },
      ]).status,
    ).toBe("reversed");
    expect(
      combineWorkReversalOutcome(
        {
          status: "reversed",
          documents: [{ documentId: "document-a", uri: "manuscript://a", status: "reversed" }],
        },
        [
          {
            command: "restore",
            projectId: "project-1",
            workId: "w1" as never,
            name: "Arc",
            status: "failed",
          },
        ],
      ).status,
    ).toBe("partial_failure");
  });

  it("undoes update/archive to the exact captured state", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    await h.works.update(work.id, { name: "Arc revised" });
    await h.works.archive(work.id);
    const receipt: WorkReceipt = {
      operation: "update",
      changed: true,
      workId: work.id,
      workName: "Arc revised",
      before: state("Arc"),
      after: state("Arc revised", "archived"),
      inverse: { command: "update", workId: work.id, state: state("Arc") },
    };
    Object.assign(h.deps.blocks, {
      listByTurn: async () => [{ content: { metadata: { workReceipt: receipt } } }] as never,
    });
    // Names may repeat: another Work holding the old name doesn't block the rename's Undo.
    await h.works.create({ projectId: "project-1", name: "Arc" });
    await reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID });
    await expect(h.works.findById(work.id)).resolves.toMatchObject(persistedState("Arc"));
  });

  it("enqueues context inside the reversal transaction and returns the committed outcome", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    await h.works.update(work.id, { name: "Arc revised" });
    const receipt: WorkReceipt = {
      operation: "update",
      changed: true,
      workId: work.id,
      workName: "Arc revised",
      before: state("Arc"),
      after: state("Arc revised"),
      inverse: { command: "update", workId: work.id, state: state("Arc") },
    };
    Object.assign(h.deps.blocks, {
      listByTurn: async () => [{ content: { metadata: { workReceipt: receipt } } }] as never,
    });
    let transactionActive = false;
    h.deps.transaction = async (operation) =>
      h.works.transaction(async () => {
        transactionActive = true;
        try {
          return await operation();
        } finally {
          transactionActive = false;
        }
      });
    h.deps.workContextNotices.workChanged.mockImplementation(async () => {
      expect(transactionActive).toBe(true);
    });

    const result = await reverseWorkReceipts(h.deps, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(result).toEqual([
      expect.objectContaining({ projectId: "project-1", status: "reversed" }),
    ]);
    await expect(h.works.findById(work.id)).resolves.toMatchObject(persistedState("Arc"));

    expect(result[0]?.status).toBe("reversed");
  });

  it("restores a delete although another Work now has the name", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    await h.works.softDelete(work.id);
    const receipt: WorkReceipt = {
      operation: "delete",
      changed: true,
      workId: work.id,
      workName: work.name,
      before: state("Arc"),
      after: null,
      inverse: { command: "restore", workId: work.id },
    };
    Object.assign(h.deps.blocks, {
      listByTurn: async () => [{ content: { metadata: { workReceipt: receipt } } }] as never,
    });
    await h.works.create({ projectId: "project-1", name: "Arc" });
    await expect(
      reverseWorkReceipts(h.deps, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
    ).resolves.toEqual([expect.objectContaining({ status: "reversed" })]);
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ deletedAt: null });
  });

  it("deletes a created Work even while it remains the conversation binding", async () => {
    const h = harness([]);
    const original = await h.works.create({ projectId: "project-1", name: "Original" });
    const created = await h.works.create({ projectId: "project-1", name: "New" });
    const receipts: WorkReceipt[] = [
      {
        operation: "create",
        changed: true,
        workId: created.id,
        workName: created.name,
        before: null,
        after: state("New"),
        inverse: { command: "delete", workId: created.id },
      },
    ];
    let bound: WorkId = original.id;
    await rebindThreadWork(
      {
        threads: h.deps.threads,
        works: h.works,
        threadWorks: {
          rebindPrimary: async (_threadId, next) => {
            const previousWorkId = bound;
            bound = next;
            return { previousWorkId, changed: previousWorkId !== next };
          },
        },
        workContextNotices: { threadChanged: vi.fn(async () => {}) },
      },
      { threadId: THREAD_ID, workId: created.id },
    );
    Object.assign(h.deps.blocks, {
      listByTurn: async () =>
        receipts.map((workReceipt) => ({ content: { metadata: { workReceipt } } })) as never,
    });

    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual([expect.objectContaining({ command: "delete", status: "reversed" })]);
    await expect(h.works.findById(created.id)).resolves.toMatchObject({
      deletedAt: expect.any(String),
    });
    expect(h.deps.workContextNotices.workChanged).not.toHaveBeenCalled();
  });

  it("keeps changed-false receipts out of reversal planning", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    const receipt: WorkReceipt = {
      ...updateReceipt(work.id, "Arc", "Arc"),
      changed: false,
      inverse: null,
    };
    Object.assign(h.deps.blocks, {
      listByTurn: async () => [{ content: { metadata: { workReceipt: receipt } } }] as never,
    });
    await expect(
      getTurnReceiptChip(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toBeNull();
    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual([]);
  });

  it("undoes A to B to C updates in reverse order, then reads Undone", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "A" });
    await h.works.update(work.id, { name: "C" });
    const receipts: WorkReceipt[] = [
      updateReceipt(work.id, "A", "B"),
      updateReceipt(work.id, "B", "C"),
    ];
    Object.assign(h.deps.blocks, {
      listByTurn: async () =>
        receipts.map((workReceipt) => ({ content: { metadata: { workReceipt } } })) as never,
    });

    await expect(
      getTurnReceiptChip(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toMatchObject({ control: "undo" });
    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "reversed" }),
      expect.objectContaining({ status: "reversed" }),
    ]);
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ name: "A" });
    await expect(
      getTurnReceiptChip(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toMatchObject({ state: "undone", control: "view_change" });
  });

  it("reports external C to D divergence without overwriting it", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "A" });
    await h.works.update(work.id, { name: "C" });
    const receipts = [updateReceipt(work.id, "A", "B"), updateReceipt(work.id, "B", "C")];
    Object.assign(h.deps.blocks, {
      listByTurn: async () =>
        receipts.map((workReceipt) => ({ content: { metadata: { workReceipt } } })) as never,
    });

    await expect(
      getTurnReceiptChip(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toMatchObject({ control: "undo" });
    await h.works.update(work.id, { name: "D" });
    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "unavailable" }),
      expect.objectContaining({ status: "unavailable" }),
    ]);
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ name: "D" });
  });

  it("undoes a mixed update then delete sequence", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "A" });
    await h.works.update(work.id, { name: "B" });
    await h.works.softDelete(work.id);
    const receipts: WorkReceipt[] = [
      updateReceipt(work.id, "A", "B"),
      {
        operation: "delete",
        changed: true,
        workId: work.id,
        workName: "B",
        before: state("B"),
        after: null,
        inverse: { command: "restore", workId: work.id },
      },
    ];
    Object.assign(h.deps.blocks, {
      listByTurn: async () =>
        receipts.map((workReceipt) => ({ content: { metadata: { workReceipt } } })) as never,
    });

    await reverseWorkReceipts(h.deps, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ name: "A", deletedAt: null });
  });
});

function updateReceipt(workId: WorkId, before: string, after: string): WorkReceipt {
  return {
    operation: "update",
    changed: true,
    workId,
    workName: after,
    before: state(before),
    after: state(after),
    inverse: { command: "update", workId, state: state(before) },
  };
}
