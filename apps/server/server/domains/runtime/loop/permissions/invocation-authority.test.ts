/** Delegation authority: a patch never grants beyond the caller, and the agent chain reads every link. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import type { AgentRevisionBinding } from "../../../packages/index.js";
import { readAgentChain } from "./agent-chain.js";
import { validateInvocationAuthority } from "./invocation-authority.js";

function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
  return {
    model: "m",
    skills: { load: [], available: [] },
    namedTargets: [],
    permission: "edit",
    ...input,
  };
}

const WRITER_MAP = { read: "allow", edit: "allow", ask_user: "allow" } as const;
const CRITIC_MAP = { read: "allow", edit: "deny", ask_user: "allow" } as const;

describe("validateInvocationAuthority", () => {
  it("rejects a deny-removal the caller cannot itself perform", () => {
    const baseline = config({ tools: CRITIC_MAP });
    const patched = config({ tools: WRITER_MAP });
    const caller = config({ tools: CRITIC_MAP });
    const reasons = validateInvocationAuthority({ baseline, patched, caller });
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).toContain('Tool "write" is not enabled for the caller.');
  });

  it("does not re-validate a named child's own definition-granted tools", () => {
    const baseline = config({ tools: WRITER_MAP });
    const patched = config({ tools: WRITER_MAP });
    const caller = config({ tools: CRITIC_MAP });
    expect(validateInvocationAuthority({ baseline, patched, caller })).toEqual([]);
  });
});

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
    const works = new Map([
      ["no-work", { id: "no-work", isNoWork: true }],
      ["work-x", { id: "work-x", isNoWork: false }],
      ["work-y", { id: "work-y", isNoWork: false }],
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
      works: { findById: async (id: WorkId) => (works.get(id) as Work | undefined) ?? null },
    };

    expect(await readAgentChain(deps, "child" as ThreadId)).toEqual([
      { threadId: "child", permission: "edit", threadWorkId: "work-x", threadWorkIsNoWork: false },
      { threadId: "parent", permission: "read", threadWorkId: "no-work", threadWorkIsNoWork: true },
    ]);
    primaries.set("parent", "work-y");
    expect((await readAgentChain(deps, "child" as ThreadId))[1]).toMatchObject({
      threadWorkId: "work-y",
      threadWorkIsNoWork: false,
    });
  });
});
