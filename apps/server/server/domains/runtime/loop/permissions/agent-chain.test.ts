/** The agent chain reads every link fresh, up to the root. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import type { AgentRevisionBinding } from "../../../packages/index.js";
import { readAgentChain } from "./agent-chain.js";

function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
  return {
    model: "m",
    skills: { load: [], available: [] },
    namedTargets: [],
    permission: "edit",
    ...input,
  };
}

describe("readAgentChain", () => {
  it("returns each link's own permission and Work up to the root, read fresh per call", async () => {
    const threads = new Map([
      ["parent", { id: "parent", parentThreadId: null }],
      ["child", { id: "child", parentThreadId: "parent" }],
    ]);
    const permissions = new Map([
      ["parent", "read"],
      ["child", "edit"],
    ] as const);
    const primaries = new Map([
      ["parent", "no-work"],
      ["child", "work-x"],
    ]);
    const deps = {
      threads: {
        findByIdIncludingDeleted: async (id: ThreadId) =>
          (threads.get(id) as Thread | undefined) ?? null,
      },
      agentRevisions: {
        readThreadBinding: async (id: string) => {
          const permission = permissions.get(id as "parent" | "child");
          return permission
            ? ({ configuration: config({ permission }) } as AgentRevisionBinding)
            : undefined;
        },
      },
      threadWorks: {
        findPrimary: async (id: ThreadId) => {
          const workId = primaries.get(id);
          return workId ? { workId: workId as WorkId } : null;
        },
      },
    };

    expect(await readAgentChain(deps, "child" as ThreadId)).toEqual([
      { threadId: "child", permission: "edit", threadWorkId: "work-x" },
      { threadId: "parent", permission: "read", threadWorkId: "no-work" },
    ]);
    primaries.set("parent", "work-y");
    expect((await readAgentChain(deps, "child" as ThreadId))[1]).toMatchObject({
      threadWorkId: "work-y",
    });
  });
});
