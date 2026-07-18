import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  contextPortForProjectRecovery,
  contextPortForThread,
  resolveThreadContext,
} from "./context-port-resolution.js";
import type { ContextPort } from "./ports/context-port.js";
import type { UnifiedContextPortFactory } from "./unified-context-port-factory.js";

const CUSTOM_PROJECT_ID = "project-custom";
const THREAD_ID = "thread-custom";
const WORK_ID = "work-custom";

function thread(): Thread {
  return {
    id: THREAD_ID,
    projectId: CUSTOM_PROJECT_ID,
    workId: WORK_ID,
    userId: "user-1",
    kind: "primary",
    status: "active",
    title: "Custom project thread",
    currentAgent: null,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: THREAD_ID,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("thread context-port resolution", () => {
  it("binds manuscript URIs to the thread project rather than a fallback project", async () => {
    const resolution = await resolveThreadContext(
      {
        threads: { findById: async () => thread() },
        threadWorks: {
          findPrimary: async () => ({ workId: WORK_ID }),
          listByThread: async () => [{ workId: WORK_ID, isPrimary: true }],
        },
      },
      THREAD_ID,
    );
    if (!resolution) throw new Error("missing resolution");

    const calls: Array<{ workId: string; projectId: string; threadId?: string }> = [];
    const contextPorts: UnifiedContextPortFactory = {
      forWork: (workId, projectId, _userId, _workMemberships, threadId) => {
        calls.push({ workId, projectId, ...(threadId ? { threadId } : {}) });
        return {} as ContextPort;
      },
      forProject: () => {
        throw new Error("thread with primary work must not fall back to project port");
      },
    };

    contextPortForThread(contextPorts, resolution);

    expect(calls).toEqual([{ workId: WORK_ID, projectId: CUSTOM_PROJECT_ID, threadId: THREAD_ID }]);
  });
});

describe("project recovery context-port resolution", () => {
  it("authorizes every active Work while keeping the requested Work primary", async () => {
    const calls: Array<{ workId: string; authorities: string[] }> = [];
    const contextPorts = {
      forWork: (workId: string, _projectId: string, _userId: string, authorities: Set<string>) => {
        calls.push({ workId, authorities: [...authorities] });
        return {} as ContextPort;
      },
      forProject: () => {
        throw new Error("active Works must use a Work-scoped recovery port");
      },
    } as UnifiedContextPortFactory;

    await contextPortForProjectRecovery({
      deps: {
        contextPorts,
        works: {
          findById: async () => null,
          listByProject: async () =>
            ["work-1", "work-2"].map((id) => ({ id })) as Awaited<
              ReturnType<import("../projects/index.js").WorkRepository["listByProject"]>
            >,
        },
      },
      projectId: CUSTOM_PROJECT_ID,
      userId: "user-1",
      requestedWorkId: "work-1",
    });

    expect(calls).toEqual([{ workId: "work-1", authorities: ["work-1", "work-2"] }]);
  });
});
