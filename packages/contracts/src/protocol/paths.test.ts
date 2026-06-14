import { describe, expect, it } from "vitest";

import {
  API_THREADS_PATH,
  API_THREADS_WS_PATH,
  apiThreadCancelPath,
  apiThreadMessagePath,
  apiThreadModelRequestsDebugPath,
  apiThreadPath,
  apiThreadSnapshotPath,
  apiThreadsWsPath,
  apiThreadTurnContextPreviewDebugPath,
  YJS_WS_PATH_PREFIX,
  yjsWsPath,
} from "./paths";

describe("api paths contract", () => {
  it("keeps thread HTTP routes on /api/threads*", () => {
    expect(API_THREADS_PATH).toBe("/api/threads");
    expect(apiThreadPath("thread_123")).toBe("/api/threads/thread_123");
    expect(apiThreadMessagePath("thread_123")).toBe("/api/threads/thread_123/messages");
    expect(apiThreadCancelPath("thread_123", "turn_123")).toBe(
      "/api/threads/thread_123/turns/turn_123/cancel",
    );
    expect(apiThreadModelRequestsDebugPath("thread_123")).toBe(
      "/api/threads/thread_123/debug/model-requests",
    );
    expect(apiThreadModelRequestsDebugPath("thread_123", { turnId: "turn_1" })).toBe(
      "/api/threads/thread_123/debug/model-requests?turnId=turn_1",
    );
    expect(apiThreadTurnContextPreviewDebugPath("thread_123")).toBe(
      "/api/threads/thread_123/debug/turn-context-preview",
    );
    expect(apiThreadSnapshotPath("thread_123")).toBe("/api/threads/thread_123/snapshot");
    expect(apiThreadSnapshotPath("thread_123", { after: "10" })).toBe(
      "/api/threads/thread_123/snapshot?after=10",
    );
  });

  it("keeps websocket events on /api/threads/ws", () => {
    expect(API_THREADS_WS_PATH).toBe("/api/threads/ws");
    expect(apiThreadsWsPath()).toBe("/api/threads/ws");
  });

  it("keeps the multiplexed Yjs websocket route on /ws/yjs", () => {
    expect(YJS_WS_PATH_PREFIX).toBe("/ws/yjs");
    expect(yjsWsPath()).toBe("/ws/yjs");
  });
});
