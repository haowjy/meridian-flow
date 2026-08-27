/** Typed Work receipt reversal behavior and ordering. */
import type { WorkReceipt } from "@meridian/contracts/works";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkRepository } from "../domains/projects/index.js";
import {
  combineWorkReversalOutcome,
  getWorkReceiptReversalAvailability,
  reverseWorkReceipts,
} from "./work-receipt-reversal.js";

const THREAD_ID = "thread-1" as never;
const TURN_ID = "turn-1" as never;

function harness(receipts: WorkReceipt[]) {
  let liveThreadWorkId: WorkReceipt["workId"] | null = null;
  const works = createInMemoryWorkRepository({
    hasLiveThreads: (workId) => workId === liveThreadWorkId,
  });
  const setCurrentWorkId = vi.fn(async () => {});
  return {
    works,
    setCurrentWorkId,
    setLiveThreadWork(workId: WorkReceipt["workId"] | null) {
      liveThreadWorkId = workId;
    },
    deps: {
      works,
      preferences: { setCurrentWorkId },
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
      workContextDelivery: { projectChanged: vi.fn(async () => {}) },
      transaction: works.transaction,
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
  return { name, goal: null, description: null, status } as const;
}

describe("Work receipt reversal", () => {
  it("aggregates successful and failed Work parts truthfully", () => {
    expect(
      combineWorkReversalOutcome(
        { status: "nothing_to_undo", documents: [] },
        [{ command: "restore", workId: "w1" as never, name: "Arc", status: "reversed" }],
        "undo",
      ).status,
    ).toBe("reversed");
    expect(
      combineWorkReversalOutcome(
        { status: "reconciled", documents: [{ uri: "manuscript://a", status: "reconciled" }] },
        [{ command: "restore", workId: "w1" as never, name: "Arc", status: "failed" }],
        "undo",
      ).status,
    ).toBe("partial_failure");
  });

  it("undoes and redoes update/archive to exact captured states", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    await h.works.update(work.id, { name: "Arc revised" });
    await h.works.archive(work.id);
    const receipt: WorkReceipt = {
      operation: "update",
      category: "mutate",
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
    await reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" });
    await expect(h.works.findById(work.id)).resolves.toMatchObject(state("Arc"));
    await reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "redo" });
    await expect(h.works.findById(work.id)).resolves.toMatchObject(
      state("Arc revised", "archived"),
    );
  });

  it("enqueues context inside the reversal transaction and returns the committed outcome", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    await h.works.update(work.id, { name: "Arc revised" });
    const receipt: WorkReceipt = {
      operation: "update",
      category: "mutate",
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
    h.deps.workContextDelivery.projectChanged.mockImplementation(async () => {
      expect(transactionActive).toBe(true);
    });

    const result = await reverseWorkReceipts(h.deps, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      direction: "undo",
    });
    expect(result).toEqual([expect.objectContaining({ status: "reversed" })]);
    await expect(h.works.findById(work.id)).resolves.toMatchObject(state("Arc"));

    expect(result[0]?.status).toBe("reversed");
  });

  it("restores delete and reports reclaimed name as an explicit failure", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    await h.works.softDelete(work.id);
    const receipt: WorkReceipt = {
      operation: "delete",
      category: "mutate",
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
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: false, redo: false });
    await expect(
      reverseWorkReceipts(h.deps, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
      }),
    ).resolves.toEqual([expect.objectContaining({ status: "unavailable" })]);
  });

  it("ignores a factual switch receipt while reversing an update in the same turn", async () => {
    const h = harness([]);
    const updated = await h.works.create({ projectId: "project-1", name: "Original" });
    const target = await h.works.create({ projectId: "project-1", name: "Other" });
    await h.works.update(updated.id, { name: "Revised" });
    h.setLiveThreadWork(target.id);
    const receipts: WorkReceipt[] = [
      updateReceipt(updated.id, "Original", "Revised"),
      switchReceipt({ ...updated, name: "Revised" }, target),
    ];
    Object.assign(h.deps.blocks, {
      listByTurn: async () =>
        receipts.map((workReceipt) => ({ content: { metadata: { workReceipt } } })) as never,
    });

    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" }),
    ).resolves.toEqual([expect.objectContaining({ command: "update", status: "reversed" })]);
    await expect(h.works.findById(updated.id)).resolves.toMatchObject({
      name: "Original",
      deletedAt: null,
    });
    expect(h.setCurrentWorkId).not.toHaveBeenCalled();
    expect(h.deps.workContextDelivery.projectChanged).toHaveBeenCalledOnce();
  });

  it("does not delete a created Work that remains the conversation binding", async () => {
    const h = harness([]);
    const original = await h.works.create({ projectId: "project-1", name: "Original" });
    const created = await h.works.create({ projectId: "project-1", name: "New" });
    h.setLiveThreadWork(created.id);
    const receipts: WorkReceipt[] = [
      {
        operation: "create",
        category: "mutate",
        changed: true,
        workId: created.id,
        workName: created.name,
        before: null,
        after: state("New"),
        inverse: { command: "delete", workId: created.id, previousCurrentWorkId: original.id },
      },
      switchReceipt(original, created),
    ];
    Object.assign(h.deps.blocks, {
      listByTurn: async () =>
        receipts.map((workReceipt) => ({ content: { metadata: { workReceipt } } })) as never,
    });

    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" }),
    ).resolves.toEqual([expect.objectContaining({ command: "delete", status: "failed" })]);
    await expect(h.works.findById(created.id)).resolves.toMatchObject({ deletedAt: null });
    expect(h.setCurrentWorkId).not.toHaveBeenCalled();
    expect(h.deps.workContextDelivery.projectChanged).not.toHaveBeenCalled();
  });

  it("never exposes a switch-only turn through Undo or Redo", async () => {
    const h = harness([]);
    const a = await h.works.create({ projectId: "project-1", name: "A" });
    const b = await h.works.create({ projectId: "project-1", name: "B" });
    const receipt = switchReceipt(a, b);
    Object.assign(h.deps.blocks, {
      listByTurn: async () => [{ content: { metadata: { workReceipt: receipt } } }] as never,
    });

    await expect(
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: false, redo: false });
    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" }),
    ).resolves.toEqual([]);
  });

  it("does not expose a no-op receipt and flips availability after undo", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "Arc" });
    const receipt: WorkReceipt = {
      operation: "create",
      category: "mutate",
      changed: true,
      workId: work.id,
      workName: work.name,
      before: null,
      after: state("Arc"),
      inverse: { command: "delete", workId: work.id, previousCurrentWorkId: null },
    };
    Object.assign(h.deps.blocks, {
      listByTurn: async () => [{ content: { metadata: { workReceipt: receipt } } }] as never,
    });
    await expect(
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: true, redo: false });
    await reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" });
    await expect(
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: false, redo: true });
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
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: false, redo: false });
    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" }),
    ).resolves.toEqual([]);
  });

  it("plans A to B to C updates in reverse and forward order", async () => {
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
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: true, redo: false });
    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "reversed" }),
      expect.objectContaining({ status: "reversed" }),
    ]);
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ name: "A" });
    await expect(
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: false, redo: true });
    await reverseWorkReceipts(h.deps, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      direction: "redo",
    });
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ name: "C" });
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
      getWorkReceiptReversalAvailability(h.deps, { threadId: THREAD_ID, turnId: TURN_ID }),
    ).resolves.toEqual({ undo: true, redo: false });
    await h.works.update(work.id, { name: "D" });
    await expect(
      reverseWorkReceipts(h.deps, { threadId: THREAD_ID, turnId: TURN_ID, direction: "undo" }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "unavailable" }),
      expect.objectContaining({ status: "unavailable" }),
    ]);
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ name: "D" });
  });

  it("undoes and redoes a mixed update then delete sequence", async () => {
    const h = harness([]);
    const work = await h.works.create({ projectId: "project-1", name: "A" });
    await h.works.update(work.id, { name: "B" });
    await h.works.softDelete(work.id);
    const receipts: WorkReceipt[] = [
      updateReceipt(work.id, "A", "B"),
      {
        operation: "delete",
        category: "mutate",
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
      direction: "undo",
    });
    await expect(h.works.findById(work.id)).resolves.toMatchObject({ name: "A", deletedAt: null });
    await reverseWorkReceipts(h.deps, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      direction: "redo",
    });
    await expect(h.works.findById(work.id)).resolves.toMatchObject({
      name: "B",
      deletedAt: expect.any(String),
    });
  });
});

function updateReceipt(workId: WorkReceipt["workId"], before: string, after: string): WorkReceipt {
  return {
    operation: "update",
    category: "mutate",
    changed: true,
    workId,
    workName: after,
    before: state(before),
    after: state(after),
    inverse: { command: "update", workId, state: state(before) },
  };
}

function switchReceipt(
  before: { id: WorkReceipt["workId"]; name: string },
  after: { id: WorkReceipt["workId"]; name: string },
): WorkReceipt {
  return {
    operation: "switch",
    category: "binding",
    changed: true,
    workId: after.id,
    workName: after.name,
    before: state(before.name),
    after: state(after.name),
    inverse: null,
  };
}
