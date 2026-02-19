import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  drainPendingSaves,
  initPersistentSaveDrain,
  cleanupPersistentSaveDrain,
} from "@/core/lib/persistentSaveDrain";
import { AppError, ErrorType } from "@/core/lib/errors";

type PendingSaveRow = {
  documentId: string;
  content: string;
  createdAt: string;
};

const { mockToArray, mockGet, mockDelete, mockSyncDocument } = vi.hoisted(
  () => ({
    mockToArray: vi.fn(async (): Promise<PendingSaveRow[]> => []),
    mockGet: vi.fn(
      async (documentId: string): Promise<PendingSaveRow | undefined> => {
        void documentId;
        return undefined;
      },
    ),
    mockDelete: vi.fn(async (): Promise<void> => void 0),
    mockSyncDocument: vi.fn(async (): Promise<unknown> => ({})),
  }),
);

vi.mock("@/core/lib/db", () => ({
  db: {
    pendingDocumentSaves: {
      toArray: mockToArray,
      get: mockGet,
      delete: mockDelete,
    },
  },
}));

vi.mock("@/core/lib/sync", () => ({
  syncDocument: mockSyncDocument,
}));

async function flushAsyncDrain(): Promise<void> {
  // drainPendingSaves is triggered via `void` (fire-and-forget), so assertions
  // must wait a tick for its async body to run.
  await Promise.resolve();
  await Promise.resolve();
}

describe("drainPendingSaves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupPersistentSaveDrain();
    mockGet.mockImplementation(
      async (documentId: string): Promise<PendingSaveRow> => ({
        documentId,
        content: "latest",
        createdAt: "2025-01-01T00:00:00Z",
      }),
    );
  });

  afterEach(() => {
    cleanupPersistentSaveDrain();
  });

  it("does nothing when no pending saves exist", async () => {
    mockToArray.mockResolvedValue([]);

    await drainPendingSaves();

    expect(mockToArray).toHaveBeenCalledTimes(1);
    expect(mockSyncDocument).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("syncs pending saves and removes successful ones", async () => {
    mockToArray.mockResolvedValue([
      { documentId: "d1", content: "hello", createdAt: "2025-01-01T00:00:00Z" },
      { documentId: "d2", content: "world", createdAt: "2025-01-01T00:00:00Z" },
    ]);
    mockSyncDocument.mockResolvedValue({ id: "ok" });

    await drainPendingSaves();

    expect(mockSyncDocument).toHaveBeenCalledTimes(2);
    expect(mockSyncDocument).toHaveBeenCalledWith("d1", "hello");
    expect(mockSyncDocument).toHaveBeenCalledWith("d2", "world");
    expect(mockDelete).toHaveBeenCalledWith("d1");
    expect(mockDelete).toHaveBeenCalledWith("d2");
  });

  it("keeps failed saves for next drain cycle", async () => {
    mockToArray.mockResolvedValue([
      { documentId: "d1", content: "hello", createdAt: "2025-01-01T00:00:00Z" },
      { documentId: "d2", content: "world", createdAt: "2025-01-01T00:00:00Z" },
    ]);
    // d1 succeeds, d2 fails
    mockSyncDocument
      .mockResolvedValueOnce({ id: "d1" })
      .mockRejectedValueOnce(new AppError(ErrorType.ServerError, "5xx"));

    await drainPendingSaves();

    // d1 was deleted from the table (success)
    expect(mockDelete).toHaveBeenCalledWith("d1");
    // d2 was NOT deleted (failure — stays for next drain)
    expect(mockDelete).not.toHaveBeenCalledWith("d2");
  });

  it("does not delete a row if a newer pending save replaced it mid-drain", async () => {
    mockToArray.mockResolvedValue([
      { documentId: "d1", content: "old", createdAt: "2025-01-01T00:00:00Z" },
    ]);
    mockSyncDocument.mockResolvedValue({ id: "d1" });
    mockGet.mockResolvedValue({
      documentId: "d1",
      content: "newer",
      createdAt: "2025-01-01T00:00:01Z",
    });

    await drainPendingSaves();

    expect(mockDelete).not.toHaveBeenCalledWith("d1");
  });

  it("removes permanently failing saves to avoid infinite retries", async () => {
    mockToArray.mockResolvedValue([
      { documentId: "d1", content: "bad", createdAt: "2025-01-01T00:00:00Z" },
    ]);
    mockSyncDocument.mockRejectedValue(
      new AppError(ErrorType.Validation, "invalid content"),
    );
    mockGet.mockResolvedValue({
      documentId: "d1",
      content: "bad",
      createdAt: "2025-01-01T00:00:00Z",
    });

    await drainPendingSaves();

    expect(mockDelete).toHaveBeenCalledWith("d1");
  });

  it("guards against concurrent drains", async () => {
    // Make toArray slow to simulate an in-progress drain
    let resolveToArray: (v: never[]) => void;
    mockToArray.mockImplementation(
      () => new Promise<never[]>((r) => (resolveToArray = r)),
    );

    const first = drainPendingSaves();
    const second = drainPendingSaves(); // should bail out immediately

    // Resolve the first drain
    resolveToArray!([]);
    await first;
    await second;

    // toArray should only be called once (second drain was a no-op)
    expect(mockToArray).toHaveBeenCalledTimes(1);
  });
});

describe("initPersistentSaveDrain", () => {
  let originalWindow: (Window & typeof globalThis) | undefined;

  beforeEach(() => {
    originalWindow = globalThis.window;

    const eventTarget = new EventTarget();
    const mockWindow = {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    } as unknown as Window & typeof globalThis;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: mockWindow,
    });

    vi.useFakeTimers();
    vi.clearAllMocks();
    cleanupPersistentSaveDrain();
    mockToArray.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanupPersistentSaveDrain();
    vi.useRealTimers();

    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
      return;
    }

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("runs initial drain on startup", async () => {
    initPersistentSaveDrain(5000);
    await flushAsyncDrain();

    // Initial drain is fired (async, so toArray is called)
    expect(mockToArray).toHaveBeenCalledTimes(1);
  });

  it("runs drain on periodic tick", async () => {
    initPersistentSaveDrain(100);
    await flushAsyncDrain();
    expect(mockToArray).toHaveBeenCalledTimes(1); // initial drain

    vi.advanceTimersByTime(100);
    await flushAsyncDrain();
    // Tick fires another drain
    expect(mockToArray).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    await flushAsyncDrain();
    expect(mockToArray).toHaveBeenCalledTimes(3);
  });

  it("drains on online event", async () => {
    initPersistentSaveDrain(60000); // long tick so it won't fire
    await flushAsyncDrain();
    expect(mockToArray).toHaveBeenCalledTimes(1); // initial drain

    window.dispatchEvent(new Event("online"));
    await flushAsyncDrain();
    expect(mockToArray).toHaveBeenCalledTimes(2);
  });

  it("cleans up timer and listener on cleanup", async () => {
    initPersistentSaveDrain(100);
    await flushAsyncDrain();
    cleanupPersistentSaveDrain();

    vi.advanceTimersByTime(500);
    await flushAsyncDrain();
    // Only the initial drain call — no ticks after cleanup
    expect(mockToArray).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("online"));
    await flushAsyncDrain();
    // Listener removed — no additional call
    expect(mockToArray).toHaveBeenCalledTimes(1);
  });
});
