import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PendingTreeOp } from "@/core/lib/offlineTypes";

// ---------------------------------------------------------------------------
// Mocks — set up before imports
// ---------------------------------------------------------------------------

const mockGetAllPendingOps = vi.fn<() => Promise<PendingTreeOp[]>>(
  async () => [],
);
const mockRemovePendingOp = vi.fn<(id: number) => Promise<void>>(async () => {});
const mockCoalesceOps = vi.fn<(ops: PendingTreeOp[]) => PendingTreeOp[]>(
  (ops) => ops,
);

vi.mock("@/core/services/treeSyncService", () => ({
  getAllPendingOps: () => mockGetAllPendingOps(),
  removePendingOp: (id: number) => mockRemovePendingOp(id),
  coalesceOps: (ops: PendingTreeOp[]) => mockCoalesceOps(ops),
}));

/* eslint-disable @typescript-eslint/no-unused-vars */
const mockDocRename = vi.fn(async (_id: string, _pid: string, _name: string) => ({}));
const mockDocMove = vi.fn(async (_id: string, _pid: string, _fid: string | null) => ({}));
const mockDocDelete = vi.fn(async (_id: string) => {});
const mockFolderRename = vi.fn(async (_id: string, _pid: string, _name: string) => ({}));
const mockFolderMove = vi.fn(async (_id: string, _pid: string, _parentId: string | null) => ({}));
const mockFolderDelete = vi.fn(async (_id: string) => {});
/* eslint-enable @typescript-eslint/no-unused-vars */

vi.mock("@/core/lib/api", () => ({
  api: {
    documents: {
      rename: (id: string, pid: string, name: string) => mockDocRename(id, pid, name),
      move: (id: string, pid: string, fid: string | null) => mockDocMove(id, pid, fid),
      delete: (id: string) => mockDocDelete(id),
    },
    folders: {
      rename: (id: string, pid: string, name: string) => mockFolderRename(id, pid, name),
      move: (id: string, pid: string, parentId: string | null) => mockFolderMove(id, pid, parentId),
      delete: (id: string) => mockFolderDelete(id),
    },
  },
}));

const mockLoadTree = vi.fn(async () => {});
const mockGetState = vi.fn(() => ({
  treeProjectId: "p1",
  loadTree: mockLoadTree,
}));
const mockSetState = vi.fn();

vi.mock("@/core/stores/useTreeStore", () => ({
  useTreeStore: {
    getState: () => mockGetState(),
    setState: (state: Record<string, unknown>) => mockSetState(state),
  },
}));

vi.mock("@/core/lib/errors", () => ({
  isNetworkError: vi.fn(() => false),
  isAppError: vi.fn(() => false),
  ErrorType: {
    Network: "NETWORK_ERROR",
    Validation: "VALIDATION_ERROR",
    NotFound: "NOT_FOUND",
    Unauthorized: "UNAUTHORIZED",
    Conflict: "CONFLICT",
    ServerError: "SERVER_ERROR",
    Unknown: "UNKNOWN_ERROR",
  },
}));

vi.mock("@/core/lib/logger", () => ({
  makeLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import {
  drainPendingTreeOps,
  initTreeQueueDrain,
  cleanupTreeQueueDrain,
} from "@/core/lib/treeQueueDrain";
import { isNetworkError, isAppError } from "@/core/lib/errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(
  id: number,
  opType: "rename" | "move" | "delete",
  entityType: "document" | "folder",
  entityId: string,
  params: Record<string, unknown> = {},
  projectId = "p1",
): PendingTreeOp {
  return {
    id,
    projectId,
    opType,
    entityType,
    entityId,
    params,
    createdAt: new Date().toISOString(),
    status: "pending",
  } as PendingTreeOp;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("treeQueueDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults
    mockGetAllPendingOps.mockResolvedValue([]);
    mockCoalesceOps.mockImplementation((ops) => ops);
    mockGetState.mockReturnValue({
      treeProjectId: "p1",
      loadTree: mockLoadTree,
    });
    vi.mocked(isNetworkError).mockReturnValue(false);
    vi.mocked(isAppError).mockReturnValue(false);
  });

  afterEach(() => {
    cleanupTreeQueueDrain();
  });

  // -----------------------------------------------------------------------
  // Basic drain behavior
  // -----------------------------------------------------------------------

  it("does nothing when queue is empty", async () => {
    mockGetAllPendingOps.mockResolvedValue([]);

    await drainPendingTreeOps();

    expect(mockGetAllPendingOps).toHaveBeenCalledOnce();
    expect(mockCoalesceOps).not.toHaveBeenCalled();
    expect(mockDocRename).not.toHaveBeenCalled();
  });

  it("guards against concurrent drains", async () => {
    // Create a slow-draining op
    const op = makeOp(1, "rename", "document", "d1", { name: "X" });
    let resolveRename: () => void = () => {};
    const renamePromise = new Promise<object>((resolve) => {
      resolveRename = () => resolve({});
    });
    mockDocRename.mockReturnValueOnce(renamePromise);
    mockGetAllPendingOps.mockResolvedValue([op]);

    // Start first drain (will block on the rename)
    const drain1 = drainPendingTreeOps();

    // Wait for drain to start (microtask)
    await Promise.resolve();
    await Promise.resolve();

    // Second drain should be a no-op
    const drain2 = drainPendingTreeOps();

    // Release the first drain
    resolveRename();
    await drain1;
    await drain2;

    // Only one rename call — second drain was skipped
    expect(mockDocRename).toHaveBeenCalledOnce();
  });

  // -----------------------------------------------------------------------
  // Op replay — correct API dispatch
  // -----------------------------------------------------------------------

  it("replays a document rename op", async () => {
    const op = makeOp(1, "rename", "document", "d1", { name: "New Name" });
    mockGetAllPendingOps.mockResolvedValue([op]);

    await drainPendingTreeOps();

    expect(mockDocRename).toHaveBeenCalledWith("d1", "p1", "New Name");
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
  });

  it("replays a folder rename op", async () => {
    const op = makeOp(1, "rename", "folder", "f1", { name: "Folder B" });
    mockGetAllPendingOps.mockResolvedValue([op]);

    await drainPendingTreeOps();

    expect(mockFolderRename).toHaveBeenCalledWith("f1", "p1", "Folder B");
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
  });

  it("replays a document move op", async () => {
    const op = makeOp(1, "move", "document", "d1", { folderId: "f2" });
    mockGetAllPendingOps.mockResolvedValue([op]);

    await drainPendingTreeOps();

    expect(mockDocMove).toHaveBeenCalledWith("d1", "p1", "f2");
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
  });

  it("converts empty folderId to null for move-to-root", async () => {
    const op = makeOp(1, "move", "document", "d1", { folderId: "" });
    mockGetAllPendingOps.mockResolvedValue([op]);

    await drainPendingTreeOps();

    // "" should be converted to null for the API call
    expect(mockDocMove).toHaveBeenCalledWith("d1", "p1", null);
  });

  it("replays a folder move op with root conversion", async () => {
    const op = makeOp(1, "move", "folder", "f1", { folderId: "" });
    mockGetAllPendingOps.mockResolvedValue([op]);

    await drainPendingTreeOps();

    expect(mockFolderMove).toHaveBeenCalledWith("f1", "p1", null);
  });

  it("replays a document delete op", async () => {
    const op = makeOp(1, "delete", "document", "d1", {});
    mockGetAllPendingOps.mockResolvedValue([op]);

    await drainPendingTreeOps();

    expect(mockDocDelete).toHaveBeenCalledWith("d1");
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
  });

  it("replays a folder delete op", async () => {
    const op = makeOp(1, "delete", "folder", "f1", {});
    mockGetAllPendingOps.mockResolvedValue([op]);

    await drainPendingTreeOps();

    expect(mockFolderDelete).toHaveBeenCalledWith("f1");
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("stops drain on network error, keeps remaining ops", async () => {
    const ops = [
      makeOp(1, "rename", "document", "d1", { name: "A" }),
      makeOp(2, "rename", "document", "d2", { name: "B" }),
    ];
    mockGetAllPendingOps.mockResolvedValue(ops);

    const networkErr = new Error("Failed to fetch");
    mockDocRename.mockRejectedValueOnce(networkErr);
    vi.mocked(isNetworkError).mockImplementation((e) => e === networkErr);

    await drainPendingTreeOps();

    // First op failed (network), second was never attempted
    expect(mockDocRename).toHaveBeenCalledOnce();
    // Op 1 was NOT removed from Dexie (kept for next cycle)
    expect(mockRemovePendingOp).not.toHaveBeenCalledWith(1);
    // Op 2 was never reached
    expect(mockRemovePendingOp).not.toHaveBeenCalledWith(2);
  });

  it("drops op on 404 (entity not found) and continues", async () => {
    const ops = [
      makeOp(1, "rename", "document", "d1", { name: "A" }),
      makeOp(2, "rename", "document", "d2", { name: "B" }),
    ];
    mockGetAllPendingOps.mockResolvedValue(ops);

    const notFoundErr = { type: "NOT_FOUND", name: "AppError", message: "not found" };
    mockDocRename.mockRejectedValueOnce(notFoundErr);
    vi.mocked(isAppError).mockImplementation((e) => e === notFoundErr);

    await drainPendingTreeOps();

    // Op 1 was dropped (404), op 2 was processed
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
    expect(mockDocRename).toHaveBeenCalledTimes(2);
    expect(mockRemovePendingOp).toHaveBeenCalledWith(2);
  });

  it("drops op on 409 (conflict) and stops drain", async () => {
    const ops = [
      makeOp(1, "delete", "folder", "f1", {}),
      makeOp(2, "rename", "document", "d2", { name: "B" }),
    ];
    mockGetAllPendingOps.mockResolvedValue(ops);

    const conflictErr = { type: "CONFLICT", name: "AppError", message: "conflict" };
    mockFolderDelete.mockRejectedValueOnce(conflictErr);
    vi.mocked(isAppError).mockImplementation((e) => e === conflictErr);

    await drainPendingTreeOps();

    // Op 1 was dropped (409), drain stopped before op 2
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
    expect(mockDocRename).not.toHaveBeenCalled(); // op 2 never attempted
  });

  it("drops op on other 4xx (permanent failure) and continues", async () => {
    const ops = [
      makeOp(1, "rename", "document", "d1", { name: "A" }),
      makeOp(2, "rename", "document", "d2", { name: "B" }),
    ];
    mockGetAllPendingOps.mockResolvedValue(ops);

    const validationErr = new Error("validation failed");
    mockDocRename
      .mockRejectedValueOnce(validationErr) // op 1 fails
      .mockResolvedValueOnce({}); // op 2 succeeds

    await drainPendingTreeOps();

    // Op 1 was dropped (permanent), op 2 still processed
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
    expect(mockRemovePendingOp).toHaveBeenCalledWith(2);
    expect(mockDocRename).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Coalescing
  // -----------------------------------------------------------------------

  it("coalesces ops before draining", async () => {
    const allOps = [
      makeOp(1, "rename", "document", "d1", { name: "X" }),
      makeOp(2, "rename", "document", "d1", { name: "Y" }),
    ];
    mockGetAllPendingOps.mockResolvedValue(allOps);
    // Simulate coalescing: only keep the second rename
    mockCoalesceOps.mockReturnValue([allOps[1]!]);

    await drainPendingTreeOps();

    // Superseded op (id=1) should be removed from Dexie
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
    // Only the surviving op (id=2) should be replayed
    expect(mockDocRename).toHaveBeenCalledOnce();
    expect(mockDocRename).toHaveBeenCalledWith("d1", "p1", "Y");
  });

  it("removes superseded ops from Dexie after coalescing", async () => {
    const allOps = [
      makeOp(1, "rename", "document", "d1", { name: "X" }),
      makeOp(2, "move", "document", "d1", { folderId: "f1" }),
      makeOp(3, "delete", "document", "d1", {}),
    ];
    mockGetAllPendingOps.mockResolvedValue(allOps);
    // Coalescing: delete supersedes all
    mockCoalesceOps.mockReturnValue([allOps[2]!]);

    await drainPendingTreeOps();

    // Superseded ops removed
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
    expect(mockRemovePendingOp).toHaveBeenCalledWith(2);
    // Delete replayed and removed
    expect(mockDocDelete).toHaveBeenCalledWith("d1");
    expect(mockRemovePendingOp).toHaveBeenCalledWith(3);
  });

  // -----------------------------------------------------------------------
  // Tree refresh
  // -----------------------------------------------------------------------

  it("refreshes tree before and after drain for current project", async () => {
    const op = makeOp(1, "rename", "document", "d1", { name: "X" });
    mockGetAllPendingOps.mockResolvedValue([op]);
    mockGetState.mockReturnValue({
      treeProjectId: "p1",
      loadTree: mockLoadTree,
    });

    await drainPendingTreeOps();

    // setState called to bypass freshness (pre-drain + post-drain = 2 times)
    expect(mockSetState).toHaveBeenCalledWith({ treeLoadedAt: null });
    // loadTree called for pre-drain and post-drain
    expect(mockLoadTree).toHaveBeenCalledWith("p1");
    expect(mockLoadTree).toHaveBeenCalledTimes(2);
  });

  it("skips tree refresh for projects not currently loaded", async () => {
    const op = makeOp(1, "rename", "document", "d1", { name: "X" }, "p2");
    mockGetAllPendingOps.mockResolvedValue([op]);
    // Current project is p1, but op is for p2
    mockGetState.mockReturnValue({
      treeProjectId: "p1",
      loadTree: mockLoadTree,
    });

    await drainPendingTreeOps();

    // API call still made
    expect(mockDocRename).toHaveBeenCalledWith("d1", "p2", "X");
    // But no tree refresh (wrong project)
    expect(mockLoadTree).not.toHaveBeenCalled();
  });

  it("refreshes tree on 409 conflict before stopping", async () => {
    const ops = [
      makeOp(1, "delete", "folder", "f1", {}),
    ];
    mockGetAllPendingOps.mockResolvedValue(ops);

    const conflictErr = { type: "CONFLICT", name: "AppError", message: "conflict" };
    mockFolderDelete.mockRejectedValueOnce(conflictErr);
    vi.mocked(isAppError).mockImplementation((e) => e === conflictErr);

    await drainPendingTreeOps();

    // Pre-drain refresh + conflict refresh = at least 2 refreshes
    expect(mockLoadTree).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Multiple ops in FIFO order
  // -----------------------------------------------------------------------

  it("drains multiple ops in FIFO order", async () => {
    const ops = [
      makeOp(1, "rename", "document", "d1", { name: "A" }),
      makeOp(2, "move", "folder", "f1", { folderId: "f2" }),
      makeOp(3, "delete", "document", "d2", {}),
    ];
    mockGetAllPendingOps.mockResolvedValue(ops);

    await drainPendingTreeOps();

    // All three API calls made in order
    expect(mockDocRename).toHaveBeenCalledWith("d1", "p1", "A");
    expect(mockFolderMove).toHaveBeenCalledWith("f1", "p1", "f2");
    expect(mockDocDelete).toHaveBeenCalledWith("d2");

    // All removed from Dexie
    expect(mockRemovePendingOp).toHaveBeenCalledWith(1);
    expect(mockRemovePendingOp).toHaveBeenCalledWith(2);
    expect(mockRemovePendingOp).toHaveBeenCalledWith(3);
  });

  // -----------------------------------------------------------------------
  // Init / cleanup lifecycle
  // -----------------------------------------------------------------------

  it("initTreeQueueDrain triggers an initial drain", async () => {
    mockGetAllPendingOps.mockResolvedValue([]);

    initTreeQueueDrain(60_000);

    // Wait for the async initial drain to fire
    await vi.waitFor(() => {
      expect(mockGetAllPendingOps).toHaveBeenCalledOnce();
    });
  });

  it("cleanupTreeQueueDrain cleans up without error", () => {
    // In Node test environment, init/cleanup should handle missing window gracefully.
    // The typeof window check in the source guards addEventListener/removeEventListener.
    initTreeQueueDrain(60_000);
    cleanupTreeQueueDrain();

    // If we get here without throwing, cleanup is working correctly.
    // Verify a second init+cleanup cycle also works (no double-cleanup issues).
    initTreeQueueDrain(60_000);
    cleanupTreeQueueDrain();
  });

  // -----------------------------------------------------------------------
  // Post-drain: no refresh if nothing drained
  // -----------------------------------------------------------------------

  it("skips post-drain refresh if no ops were successfully drained", async () => {
    const op = makeOp(1, "rename", "document", "d1", { name: "X" });
    mockGetAllPendingOps.mockResolvedValue([op]);

    const networkErr = new Error("Failed to fetch");
    mockDocRename.mockRejectedValueOnce(networkErr);
    vi.mocked(isNetworkError).mockImplementation((e) => e === networkErr);

    await drainPendingTreeOps();

    // Pre-drain refresh fires, but post-drain should NOT fire since nothing drained
    // Pre-drain: 1 loadTree call
    expect(mockLoadTree).toHaveBeenCalledTimes(1);
  });
});
