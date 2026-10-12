import type { AgentPermission } from "@meridian/contracts/agents";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { actionPolicy } from "./action-policy.js";
import { type AgentChain, chainPermission } from "./agent-chain.js";

function chain(...permissions: AgentPermission[]): AgentChain {
  return permissions.map((permission, index) => ({
    threadId: `thread-${index}` as ThreadId,
    permission,
    threadWorkId: "work" as WorkId,
    scratchOwner: { scope: "work", workId: "work" },
  }));
}

describe("actionPolicy", () => {
  it("denies Work changes to a default-edit child under a read parent", () => {
    expect(actionPolicy(chainPermission(chain("edit", "read")), "work.archive")).toBe("deny");
    expect(actionPolicy(chainPermission(chain("edit", "read")), "work.show")).toBe("allow");
  });
});
