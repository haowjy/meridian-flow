/** Consolidated test contracts; each block retains its original fixture scope.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Fresh permission resolution and subagent-only return_result
 */

import type { AgentPermission, ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { describe as __mergedSuite, expect, it } from "vitest";
import type { AgentRevisionBinding } from "../../packages/index.js";
import { actionPolicy } from "./permissions/action-policy.js";
import { type AgentChain, chainPermission, readAgentChain } from "./permissions/agent-chain.js";
import { projectToolPolicy, toolsBeyondParent } from "./permissions/tool-policy.js";

__mergedSuite("action-policy.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/permissions/action-policy.test.ts.
  function chain(...permissions: AgentPermission[]): AgentChain {
    return permissions.map((permission, index) => ({
      threadId: `thread-${index}` as ThreadId,
      permission,
      threadWorkId: "work" as WorkId,
      scratchOwner: { scope: "work", workId: "work" },
    }));
  }

  __mergedSuite("actionPolicy", () => {
    it("denies Work changes to a default-edit child under a read parent", () => {
      expect(actionPolicy(chainPermission(chain("edit", "read")), "work.archive")).toBe("deny");
      expect(actionPolicy(chainPermission(chain("edit", "read")), "work.switch")).toBe("deny");
      expect(actionPolicy(chainPermission(chain("edit", "read")), "work.write_mode")).toBe("deny");
      expect(actionPolicy(chainPermission(chain("edit", "read")), "work.show")).toBe("allow");
      expect(actionPolicy("edit", "work.switch")).toBe("allow");
      expect(actionPolicy("edit", "work.write_mode")).toBe("allow");
    });
  });
});

__mergedSuite("agent-chain.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/permissions/agent-chain.test.ts.
  function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
    return {
      model: "m",
      skills: { load: [], available: [] },
      namedTargets: [],
      permission: "edit",
      ...input,
    };
  }

  __mergedSuite("readAgentChain", () => {
    it("returns each link's own permission and Work up to the root, read fresh per call", async () => {
      const threads = new Map([
        [
          "parent",
          { id: "parent", projectId: "project", rootThreadId: "parent", parentThreadId: null },
        ],
        [
          "child",
          { id: "child", projectId: "project", rootThreadId: "parent", parentThreadId: "parent" },
        ],
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
        works: { findById: async (id: string) => ({ id, isNoWork: id === "no-work" }) as never },
        threads: {
          findByIdIncludingDeleted: async (id: ThreadId) => {
            const thread = threads.get(id) as Thread | undefined;
            return thread ? { ...thread, project: null } : null;
          },
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
        {
          threadId: "child",
          permission: "edit",
          threadWorkId: "work-x",
          scratchOwner: { scope: "work", workId: "work-x" },
        },
        {
          threadId: "parent",
          permission: "read",
          threadWorkId: "no-work",
          scratchOwner: { scope: "lineage", projectId: "project", rootThreadId: "parent" },
        },
      ]);
      primaries.set("parent", "work-y");
      expect((await readAgentChain(deps, "child" as ThreadId))[1]).toMatchObject({
        threadWorkId: "work-y",
      });
    });
  });
});

__mergedSuite("tool-policy.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/loop/permissions/tool-policy.test.ts.
  // ask_user is never granted while disabled (#601).
  const PRIMARY_DEFAULT = [
    "ls",
    "read",
    "grep",
    "skill",
    "spawn",
    "thread_history",
    "thread_ls",
    "thread_message",
    "thread_report",
    "work",
    "write",
  ];

  const names = (...args: Parameters<typeof projectToolPolicy>) =>
    [...projectToolPolicy(...args)].sort();

  __mergedSuite("projectToolPolicy", () => {
    it.each([
      ["an empty allow-list", { tools: [] }, "primary", []],
      ["return_result on a primary", { tools: ["read", "return_result"] }, "primary", ["read"]],
      [
        "denials",
        { "disallowed-tools": ["write", "spawn", "return_result"] },
        "subagent",
        [...PRIMARY_DEFAULT.filter((n) => n !== "write" && n !== "spawn"), "return_result"].sort(),
      ],
      [
        "a denial inside the allow-list",
        { tools: ["read", "write"], "disallowed-tools": ["write"] },
        "primary",
        ["read"],
      ],
    ] as const)("%s", (_label, configuration, kind, expected) => {
      expect(
        names(
          configuration as unknown as Parameters<typeof projectToolPolicy>[0],
          kind as Parameters<typeof projectToolPolicy>[1],
        ),
      ).toEqual(expected);
    });
  });

  function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
    return {
      model: "m",
      skills: { load: [], available: [] },
      namedTargets: [],
      permission: "edit",
      ...input,
    };
  }

  __mergedSuite("toolsBeyondParent", () => {
    it("names the child's tools its parent lacks, never return_result", () => {
      const parent = config({ "disallowed-tools": ["write", "spawn"] });
      expect(toolsBeyondParent(parent, config())).toEqual(["write", "spawn"]);
      expect(toolsBeyondParent(parent, config({ tools: ["read", "return_result"] }))).toEqual([]);
    });
  });
});
