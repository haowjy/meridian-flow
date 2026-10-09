import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { testWorkSlug } from "../../test-support/work-slug.js";
import { resolvedWorkAuthority } from "../projects/domain/work-authority.js";
import type { ProjectWorkAuthorityResolver } from "../projects/index.js";
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

function resolver(slugs: Record<string, string>): ProjectWorkAuthorityResolver {
  const byId = async (_projectId: string, workId: string) => {
    const slug = slugs[workId];
    return slug ? resolvedWorkAuthority({ workId, workSlug: testWorkSlug(slug) }) : null;
  };
  return { byId, noWork: async () => null, lockById: byId, bySlug: async () => null };
}

function thread(): Thread {
  return {
    id: THREAD_ID,
    projectId: CUSTOM_PROJECT_ID,
    workId: WORK_ID,
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
          listByProject: async () => [{ id: WORK_ID, slug: "current-work" }] as never,
        },
        workAuthorityResolver: resolver({ [WORK_ID]: "current-work" }),
      },
      THREAD_ID,
    );
    if (!resolution) throw new Error("missing resolution");

    const calls: Array<{ workId: string; projectId: string; threadId?: string }> = [];
    const contextPorts: UnifiedContextPortFactory = {
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
              slug: `work-${index + 1}`,
            })) as Awaited<
              ReturnType<import("../projects/index.js").WorkRepository["listByProject"]>
            >,
        },
        workAuthorityResolver: resolver({ "work-1": "work-1", "work-2": "work-2" }),
      },
      projectId: CUSTOM_PROJECT_ID,
      userId: "user-1",
      requestedWorkId: "work-1",
    });

    expect(calls).toEqual([{ workId: "work-1", authorities: ["work-1", "work-2"] }]);
  });
});
