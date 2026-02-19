import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PendingTreeOp } from "@/core/lib/offlineTypes";

// ---------------------------------------------------------------------------
// Mock Dexie before importing the service
// ---------------------------------------------------------------------------

const mockOps: PendingTreeOp[] = [];
let autoId = 1;

vi.mock("@/core/lib/db", () => {
  return {
    db: {
      pendingTreeOps: {
        add: vi.fn(async (op: PendingTreeOp) => {
          op.id = autoId++;
          mockOps.push(op);
          return op.id;
        }),
        delete: vi.fn(async (id: number) => {
          const idx = mockOps.findIndex((op) => op.id === id);
          if (idx >= 0) mockOps.splice(idx, 1);
        }),
        bulkDelete: vi.fn(async (ids: number[]) => {
          for (const id of ids) {
            const idx = mockOps.findIndex((op) => op.id === id);
            if (idx >= 0) mockOps.splice(idx, 1);
          }
        }),
        where: vi.fn((index: string) => {
          if (index === "[projectId+status]") {
            return {
              equals: vi.fn(([projectId, status]: [string, string]) => ({
                sortBy: vi.fn(async () =>
                  mockOps
                    .filter(
                      (op) =>
                        op.projectId === projectId && op.status === status,
                    )
                    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
                ),
              })),
            };
          }
          // Fallback for entityId-based queries (getPendingOpsForEntity, removeOpsForEntity)
          return {
            above: vi.fn(() => ({
              filter: vi.fn((fn: (op: PendingTreeOp) => boolean) => ({
                sortBy: vi.fn(async () =>
                  mockOps.filter(fn).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
                ),
                toArray: vi.fn(async () => mockOps.filter(fn)),
              })),
            })),
          };
        }),
      },
    },
  };
});

vi.mock("@/core/lib/logger", () => ({
  makeLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks are set up
import {
  queueTreeOp,
  getPendingOpsForProject,
  getPendingOpsForEntity,
  removePendingOp,
  removeOpsForEntity,
  coalesceOps,
} from "@/core/services/treeSyncService";

describe("treeSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOps.length = 0;
    autoId = 1;
  });

  describe("queueTreeOp", () => {
    it("adds a rename op to the queue", async () => {
      await queueTreeOp("p1", "rename", "document", "d1", { name: "New Name" });

      expect(mockOps).toHaveLength(1);
      expect(mockOps[0]).toMatchObject({
        projectId: "p1",
        opType: "rename",
        entityType: "document",
        entityId: "d1",
        params: { name: "New Name" },
        status: "pending",
      });
    });

    it("adds a delete op to the queue", async () => {
      await queueTreeOp("p1", "delete", "folder", "f1", {});

      expect(mockOps).toHaveLength(1);
      expect(mockOps[0]).toMatchObject({
        opType: "delete",
        entityType: "folder",
        entityId: "f1",
        status: "pending",
      });
    });

    it("adds a move op to the queue", async () => {
      await queueTreeOp("p1", "move", "document", "d1", { folderId: "f2" });

      expect(mockOps).toHaveLength(1);
      expect(mockOps[0]).toMatchObject({
        opType: "move",
        entityId: "d1",
        params: { folderId: "f2" },
      });
    });
  });

  describe("getPendingOpsForProject", () => {
    it("returns only pending ops for the given project", async () => {
      await queueTreeOp("p1", "rename", "document", "d1", { name: "A" });
      await queueTreeOp("p2", "rename", "document", "d2", { name: "B" });
      await queueTreeOp("p1", "delete", "folder", "f1", {});

      const ops = await getPendingOpsForProject("p1");
      expect(ops).toHaveLength(2);
      expect(ops[0]!.entityId).toBe("d1");
      expect(ops[1]!.entityId).toBe("f1");
    });
  });

  describe("getPendingOpsForEntity", () => {
    it("returns ops for a specific entity", async () => {
      await queueTreeOp("p1", "rename", "document", "d1", { name: "A" });
      await queueTreeOp("p1", "move", "document", "d1", { folderId: "f2" });
      await queueTreeOp("p1", "rename", "document", "d2", { name: "B" });

      const ops = await getPendingOpsForEntity("d1");
      expect(ops).toHaveLength(2);
      expect(ops.every((op) => op.entityId === "d1")).toBe(true);
    });
  });

  describe("removePendingOp", () => {
    it("removes a single op by id", async () => {
      await queueTreeOp("p1", "rename", "document", "d1", { name: "A" });
      await queueTreeOp("p1", "rename", "document", "d2", { name: "B" });

      expect(mockOps).toHaveLength(2);
      await removePendingOp(mockOps[0]!.id!);
      expect(mockOps).toHaveLength(1);
      expect(mockOps[0]!.entityId).toBe("d2");
    });
  });

  describe("removeOpsForEntity", () => {
    it("removes only pending ops for a given entity", async () => {
      await queueTreeOp("p1", "rename", "document", "d1", { name: "A" });
      await queueTreeOp("p1", "move", "document", "d1", { folderId: "f2" });
      await queueTreeOp("p1", "rename", "document", "d2", { name: "B" });
      mockOps.push({
        id: autoId++,
        projectId: "p1",
        opType: "delete",
        entityType: "document",
        entityId: "d1",
        params: {},
        createdAt: new Date().toISOString(),
        status: "failed",
      });

      await removeOpsForEntity("d1");
      expect(mockOps).toHaveLength(2);
      expect(mockOps.some((op) => op.entityId === "d2")).toBe(true);
      expect(mockOps.some((op) => op.entityId === "d1" && op.status === "failed")).toBe(
        true,
      );
    });
  });
});

describe("coalesceOps", () => {
  function makeOp(
    id: number,
    opType: "rename" | "move" | "delete",
    entityId: string,
    params: Record<string, unknown> = {},
  ): PendingTreeOp {
    return {
      id,
      projectId: "p1",
      opType,
      entityType: "document",
      entityId,
      params,
      createdAt: new Date().toISOString(),
      status: "pending",
    } as PendingTreeOp;
  }

  it("returns empty array for empty input", () => {
    expect(coalesceOps([])).toEqual([]);
  });

  it("returns single op unchanged", () => {
    const ops = [makeOp(1, "rename", "d1", { name: "X" })];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(1);
  });

  it("keeps only second rename for same entity", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "rename", "d1", { name: "Y" }),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(2);
    expect((result[0] as { params: { name: string } }).params.name).toBe("Y");
  });

  it("keeps only second move for same entity", () => {
    const ops = [
      makeOp(1, "move", "d1", { folderId: "f1" }),
      makeOp(2, "move", "d1", { folderId: "f2" }),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(2);
    expect((result[0] as { params: { folderId: string } }).params.folderId).toBe("f2");
  });

  it("keeps only delete when rename then delete on same entity", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "delete", "d1"),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(1);
    expect(result[0]!.opType).toBe("delete");
    expect(result[0]!.id).toBe(2);
  });

  it("keeps only delete when move then delete on same entity", () => {
    const ops = [
      makeOp(1, "move", "d1", { folderId: "f1" }),
      makeOp(2, "delete", "d1"),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(1);
    expect(result[0]!.opType).toBe("delete");
  });

  it("keeps only delete when rename+move then delete on same entity", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "move", "d1", { folderId: "f1" }),
      makeOp(3, "delete", "d1"),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(1);
    expect(result[0]!.opType).toBe("delete");
    expect(result[0]!.id).toBe(3);
  });

  it("preserves all ops for different entities", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "rename", "d2", { name: "Y" }),
      makeOp(3, "move", "d3", { folderId: "f1" }),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(3);
  });

  it("coalesces per-entity while preserving other entities", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "rename", "d2", { name: "A" }),
      makeOp(3, "rename", "d1", { name: "Y" }),
      makeOp(4, "delete", "d2"),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(2);
    // d1: only the second rename (id=3)
    const d1Op = result.find((op) => op.entityId === "d1");
    expect(d1Op!.id).toBe(3);
    expect(d1Op!.opType).toBe("rename");
    // d2: only the delete (id=4)
    const d2Op = result.find((op) => op.entityId === "d2");
    expect(d2Op!.id).toBe(4);
    expect(d2Op!.opType).toBe("delete");
  });

  it("maintains global FIFO order in output", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "rename", "d2", { name: "A" }),
      makeOp(3, "rename", "d1", { name: "Y" }),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(2);
    // d2 rename (id=2) should come before d1 rename (id=3)
    expect(result[0]!.id).toBe(2);
    expect(result[1]!.id).toBe(3);
  });

  it("keeps last rename and last move for same entity", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "move", "d1", { folderId: "f1" }),
      makeOp(3, "rename", "d1", { name: "Y" }),
      makeOp(4, "move", "d1", { folderId: "f2" }),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(2);
    const rename = result.find((op) => op.opType === "rename");
    const move = result.find((op) => op.opType === "move");
    expect(rename!.id).toBe(3);
    expect((rename as { params: { name: string } }).params.name).toBe("Y");
    expect(move!.id).toBe(4);
    expect((move as { params: { folderId: string } }).params.folderId).toBe("f2");
  });

  it("delete supersedes all prior ops including rename and move", () => {
    const ops = [
      makeOp(1, "rename", "d1", { name: "X" }),
      makeOp(2, "move", "d1", { folderId: "f1" }),
      makeOp(3, "rename", "d1", { name: "Y" }),
      makeOp(4, "move", "d1", { folderId: "f2" }),
      makeOp(5, "delete", "d1"),
    ];
    const result = coalesceOps(ops);
    expect(result).toHaveLength(1);
    expect(result[0]!.opType).toBe("delete");
    expect(result[0]!.id).toBe(5);
  });
});
