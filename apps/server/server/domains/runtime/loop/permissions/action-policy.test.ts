import type { AgentPermission } from "@meridian/contracts/agents";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { type ActionDecision, type AgentAction, actionPolicy } from "./action-policy.js";
import type { AgentChain } from "./agent-chain.js";

function chain(...permissions: AgentPermission[]): AgentChain {
  return permissions.map((permission, index) => ({
    threadId: `thread-${index}` as ThreadId,
    permission,
    threadWorkId: "work" as WorkId,
  }));
}

const ROWS: Array<[AgentAction, ActionDecision, ActionDecision]> = [
  ["work.create", "allow", "deny"],
  ["work.update", "allow", "deny"],
  ["work.archive", "allow", "deny"],
  ["work.unarchive", "allow", "deny"],
  ["work.delete", "allow", "deny"],
  ["work.switch", "ask", "ask"],
  ["work.list", "allow", "allow"],
  ["work.show", "allow", "allow"],
];

describe("actionPolicy", () => {
  it.each(ROWS)("%s is %s for edit and %s for read", (action, edit, read) => {
    expect(actionPolicy(chain("edit"), action)).toBe(edit);
    expect(actionPolicy(chain("read"), action)).toBe(read);
  });

  it("denies Work changes to a default-edit child under a read parent", () => {
    expect(actionPolicy(chain("edit", "read"), "work.archive")).toBe("deny");
    expect(actionPolicy(chain("edit", "read"), "work.show")).toBe("allow");
  });
});
