/** Work-context rendering contract: current Work, capped recent list, and elision. */
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import { renderWorkContext, WORK_CONTEXT_ACTIVE_LIMIT } from "./work-context.js";

function work(index: number, overrides: Partial<Work> = {}): Work {
  const timestamp = new Date(2026, 0, index + 1).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    projectId: "00000000-0000-4000-8000-000000000100",
    createdByUserId: "00000000-0000-4000-8000-000000000101",
    name: `Work ${index}`,
    slug: `work-${index}`,
    goal: `Goal ${index}`,
    description: null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "direct",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    deletedAt: null,
    ...overrides,
  };
}

describe("renderWorkContext", () => {
  it("renders the current Work and a capped recent active list with an elision count", () => {
    const current = work(99, { name: "Tournament <Arc>", goal: "Write\n the climax." });
    const activeWorks = [current, ...Array.from({ length: 22 }, (_, index) => work(index))];

    const rendered = renderWorkContext({ current, activeWorks });

    expect(rendered).toContain(
      'current: work-99: "Tournament &lt;Arc&gt;" (goal: Write the climax.)',
    );
    expect(rendered).toContain(`active (most recent first; max ${WORK_CONTEXT_ACTIVE_LIMIT}):`);
    expect(rendered).toContain('  work-21: "Work 21" (goal: Goal 21)');
    expect(rendered).toContain('  work-2: "Work 2" (goal: Goal 2)');
    expect(rendered).not.toContain('  work-1: "Work 1"');
    expect(rendered).toContain("elided: 2 more active Works; use work list to see them.");
    expect(rendered.match(/work-99/g)).toHaveLength(1);
  });
});
