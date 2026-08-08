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
  const works = createInMemoryWorkRepository();
  let primaryWorkId = "";
  const rebindPrimary = vi.fn(async (_threadId: string, workId: string) => {
    const previousWorkId = primaryWorkId;
    primaryWorkId = workId;
    return { previousWorkId, changed: previousWorkId !== workId };
  });
  const setCurrentWorkId = vi.fn(async () => {});
  return {
    works,
    setPrimary(workId: string) {
      primaryWorkId = workId;
    },
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
      threadWorks: {
        findPrimary: async () => (primaryWorkId ? { workId: primaryWorkId as never } : null),
        rebindPrimary,
      },
      preferences: { setCurrentWorkId },
      contextUpdates: { projectChanged: vi.fn(async () => {}) },
      transaction: works.transaction,
      blocks: {
        listByTurn: async () =>
          receipts.map((workReceipt) => ({
            content: { metadata: { workReceipt } },
          })) as never,
      },
    },
    rebindPrimary,
    setCurrentWorkId,
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
    ).resolves.toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("reverses create plus switch in reverse tool order and restores preference", async () => {
    const h = harness([]);
    const original = await h.works.create({ projectId: "project-1", name: "Original" });
    const created = await h.works.create({ projectId: "project-1", name: "New" });
    h.setPrimary(created.id);
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
      {
        operation: "switch",
        category: "binding",
        changed: true,
        workId: created.id,
        workName: created.name,
        before: state("Original"),
        after: state("New"),
        inverse: { command: "switch", workId: original.id },
      },
    ];
    Object.assign(h.deps.blocks, {
      listByTurn: async () =>
        receipts.map((workReceipt) => ({ content: { metadata: { workReceipt } } })) as never,
    });
    const results = await reverseWorkReceipts(h.deps, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      direction: "undo",
    });
    expect(results.map((result) => result.command)).toEqual(["switch", "delete"]);
    expect(h.rebindPrimary).toHaveBeenCalledWith(THREAD_ID, original.id);
    expect(h.setCurrentWorkId).toHaveBeenLastCalledWith("user-1", "project-1", original.id);
    await expect(h.works.findById(created.id)).resolves.toMatchObject({
      deletedAt: expect.any(String),
    });
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
});
