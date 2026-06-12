/**
 * threads-api tests — verifies HTTP request wiring and snapshot deserialization
 * for the app's thread API client.
 */
import { serializeTransport } from "@meridian/contracts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendUserMessage,
  createThread,
  deleteThread,
  deserializeThreadSnapshot,
  getThreadSnapshot,
  listThreads,
} from "./threads-api";

function mockJsonFetchResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const status = init?.status ?? (init?.ok === false ? 500 : 200);
  const ok = init?.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("threads-api getThreadSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the snapshot endpoint with encoded query params and decodes transport values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonFetchResponse(
        serializeTransport({
          threadId: "thread_1",
          thread: {
            id: "thread_1",
            workbenchId: "00000000-0000-4000-8000-000000000000",
            workId: null,
            userId: "user_1",
            kind: "primary",
            status: "idle",
            title: null,
            systemPrompt: null,
            workingState: null,
            currentAgent: null,
            nextSeq: 0n,
            parentThreadId: null,
            rootThreadId: "thread_1",
            spawnDepth: 0,
            spawnStatus: null,
            spawnResult: null,
            totalCostUsd: "0",
            turnCount: 0,
            historySummary: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            deletedAt: null,
          },
          turns: [],
          liveState: {
            threadId: "thread_1",
            status: "active",
            runningTurnId: "turn_1",
            currentAgent: "assistant",
            nextSeq: "1001",
            resumeAfterSeq: "999",
          },
          waitingForUser: true,
          nextSeq: "1001",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await getThreadSnapshot({
      data: {
        threadId: "thread_1",
        after: "10",
      },
    });

    expect(snapshot.thread.createdAt).toBeInstanceOf(Date);

    const deserialized = deserializeThreadSnapshot(snapshot);
    expect(deserialized.thread.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(deserialized.liveState).toEqual({
      threadId: "thread_1",
      status: "active",
      runningTurnId: "turn_1",
      currentAgent: "assistant",
      nextSeq: "1001",
      resumeAfterSeq: "999",
    });
    expect(deserialized.waitingForUser).toBe(true);
    expect(deserialized.nextSeq).toBe("1001");
    expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread_1/snapshot?after=10", {
      method: "GET",
    });
  });
});

describe("threads-api listThreads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("supports SSR absolute-origin fetches with forwarded cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonFetchResponse({ threads: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listThreads({
      origin: "https://app.meridian.localhost",
      headers: { cookie: "workos_session=abc" },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://app.meridian.localhost/api/threads", {
      method: "GET",
      headers: { cookie: "workos_session=abc" },
    });
  });
});

describe("threads-api createThread", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the client-generated id for optimistic reconciliation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonFetchResponse({
        id: "client_thread_1",
        workbenchId: "00000000-0000-4000-8000-000000000000",
        workId: null,
        userId: "user_1",
        kind: "primary",
        status: "idle",
        title: "Hi",
        currentAgent: null,
        parentThreadId: null,
        rootThreadId: "client_thread_1",
        spawnDepth: 0,
        spawnStatus: null,
        totalCostUsd: "0",
        turnCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createThread({
      data: { id: "client_thread_1", workbenchId: "proj_1", title: "Hi" },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "client_thread_1", workbenchId: "proj_1", title: "Hi" }),
    });
  });
});

describe("threads-api deleteThread", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls DELETE on the thread resource and accepts 204", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204, headers: { get: () => null } });
    vi.stubGlobal("fetch", fetchMock);

    await deleteThread({ data: { threadId: "thread_1" } });

    expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread_1", { method: "DELETE" });
  });
});

describe("threads-api appendUserMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts 409 already_active without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonFetchResponse(
        {
          threadId: "thread_1",
          userTurnId: "",
          assistantTurnId: "",
          streamCursor: "99",
          status: "already_active",
        },
        { ok: false, status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await appendUserMessage({ data: { threadId: "thread_1", text: "hi" } });

    expect(result.status).toBe("already_active");
    expect(result.streamCursor).toBe("99");
  });
});
