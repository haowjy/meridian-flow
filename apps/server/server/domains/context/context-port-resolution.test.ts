import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { testWorkHandle } from "../../test-support/work-handle.js";
import { resolvedWorkAuthority } from "../projects/domain/work-authority.js";
import type { ProjectWorkAuthorityResolver } from "../projects/index.js";
import {
  contextPortForProjectRecovery,
  contextPortForThread,
  resolveThreadContext,
} from "./context-port-resolution.js";
import { createOwnerLookup, emptyOwnerLookup, type WorkOwner } from "./owner-lookup.js";
import type { ContextPort } from "./ports/context-port.js";
import type { UnifiedContextPortFactory } from "./unified-context-port-factory.js";

const CUSTOM_PROJECT_ID = "project-custom";
const THREAD_ID = "thread-custom";
const WORK_ID = "work-custom";

function resolver(handles: Record<string, string>): ProjectWorkAuthorityResolver {
  const byId = async (_projectId: string, workId: string) => {
    const handle = handles[workId];
    return handle ? resolvedWorkAuthority({ workId, workHandle: testWorkHandle(handle) }) : null;
  };
  return { byId, noWork: async () => null, lockById: byId, byHandle: async () => null };
}

function thread(): Thread {
  return {
    id: THREAD_ID,
    projectId: CUSTOM_PROJECT_ID,
    workId: WORK_ID,
    aiWriteMode: "direct",
    effectiveAiWriteMode: "direct",
    userId: "user-1",
    kind: "primary",
    status: "idle",
    title: "Custom project thread",
    ref: null,
    initialPromptBakeId: null,
    agentDefinitionRevisionId: null,
    agentName: null,
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
    lastActivityAt: new Date().toISOString(),
  };
}

describe("thread context-port resolution", () => {
  it("binds manuscript URIs to the thread project rather than a fallback project", async () => {
    const resolution = await resolveThreadContext(
      {
        threads: { findById: async () => thread() },
        threadWorks: { findPrimary: async () => ({ workId: WORK_ID }) },
        works: {
          findById: async () => null,
          listByProject: async () => [{ id: WORK_ID, handle: "w1" }] as never,
        },
        workAuthorityResolver: resolver({ [WORK_ID]: "w1" }),
      },
      THREAD_ID,
    );
    if (!resolution) throw new Error("missing resolution");

    const calls: Array<{ workId: string; projectId: string; threadId?: string }> = [];
    const contextPorts: UnifiedContextPortFactory = {
      topPrimaryChats: { resolveTopPrimaryChat: async () => null },
      chats: { byRef: async () => null },
      chatFiles: emptyOwnerLookup,
      lineages: {
        async byId() {
          return null;
        },
        async rootForThreadRef() {
          return null;
        },
        async byRef() {
          return null;
        },
        async list() {
          return [];
        },
      },
      forWork: (authority, projectId, _userId, _workMemberships, thread) => {
        calls.push({
          workId: authority.workId,
          projectId,
          ...(thread ? { threadId: thread.threadId } : {}),
        });
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
      forWork: (
        authority: { workId: string },
        _projectId: string,
        _userId: string,
        authorities: ReadonlyMap<string, unknown>,
      ) => {
        calls.push({ workId: authority.workId, authorities: [...authorities.keys()] });
        return {} as ContextPort;
      },
      forProject: () => {
        throw new Error("active Works must use a Work-scoped recovery port");
      },
    } as unknown as UnifiedContextPortFactory;

    await contextPortForProjectRecovery({
      deps: {
        contextPorts,
        works: {
          findById: async () => null,
          listByProject: async () =>
            ["work-1", "work-2"].map((id, index) => ({
              id,
              handle: `w${index + 1}`,
            })) as Awaited<
              ReturnType<import("../projects/index.js").WorkRepository["listByProject"]>
            >,
        },
        workAuthorityResolver: resolver({ "work-1": "w1", "work-2": "w2" }),
      },
      projectId: CUSTOM_PROJECT_ID,
      userId: "user-1",
      requestedWorkId: "work-1",
    });

    expect(calls).toEqual([{ workId: "work-1", authorities: ["w1", "w2"] }]);
  });
});

describe("owner lookup", () => {
  const allWorks: WorkOwner[] = [
    { handle: testWorkHandle("w3"), name: "Tea Notes", state: "active", restorableDays: null },
    { handle: testWorkHandle("w4"), name: "w9", state: "archived", restorableDays: null },
    { handle: testWorkHandle("w5"), name: "Gone", state: "deleted", restorableDays: 12 },
  ];
  const lookup = createOwnerLookup({
    chats: { byRef: async (_p, ref) => ({ chatId: `id-${ref}`, chatRef: ref, live: true }) },
    lineages: {
      byId: async () => null,
      byRef: async () => null,
      list: async () => [
        { projectId: "project", rootThreadId: "root", rootThreadRef: "c12", title: "Dragon fight" },
      ],
      rootForThreadRef: async (projectId, ref) => ({
        projectId,
        rootThreadId: "root",
        rootThreadRef: ref === "c15" ? "c12" : ref,
      }),
    },
    namedWorkHandle: async (id) => (id === "id-c15" ? null : "w3"),
    subagentChatRef: async (_p, ref) => (ref === "p3" ? "c15" : null),
    workByHandle: async (_p, handle) => allWorks.find((work) => work.handle === handle) ?? null,
    worksNamed: async () => allWorks.filter((work) => work.state !== "deleted"),
    listWorks: async () => allWorks.filter((work) => work.state !== "deleted"),
    chatsWithFiles: async () => [{ chatRef: "c15", title: "Map research" }],
  });

  it("names a chat's Scratch by its Work, or in No Work by its lineage's first chat", async () => {
    await expect(lookup.chat("project", "c15")).resolves.toEqual({
      uploads: "uploads://@c15/",
      scratch: "scratch://@c12/",
    });
    await expect(lookup.chat("project", "c1")).resolves.toEqual({
      uploads: "uploads://@c1/",
      scratch: "scratch://@w3/",
    });
  });

  it("answers a name from a handle-shaped label, and lists owners beside their labels", async () => {
    await expect(lookup.workReference("project", "tea-notes")).resolves.toMatchObject({
      ok: false,
      message: '"Tea Notes" is w3.',
    });
    await expect(lookup.workReference("project", "w9")).resolves.toMatchObject({
      ok: false,
      message: '"w9" is w4.',
    });
    await expect(lookup.workReference("project", "Gone")).resolves.toMatchObject({
      ok: false,
      message: "Unknown Work Gone. Use work list.",
    });
    await expect(lookup.scratchOwners("project")).resolves.toEqual([
      { uri: "scratch://@w3/", label: "Tea Notes" },
      { uri: "scratch://@w4/", label: "w9 (archived)" },
      { uri: "scratch://@c12/", label: '"Dragon fight"' },
    ]);
    await expect(lookup.uploadOwners("project")).resolves.toEqual([
      { uri: "uploads://@c15/", label: '"Map research"' },
    ]);
  });
});
