import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import { testWorkSlug } from "../../../test-support/work-slug.js";
import {
  createWorkContextReader,
  renderWorkContext,
  WORK_CONTEXT_GOAL_LIMIT,
  WORK_CONTEXT_OTHER_GOAL_LIMIT,
} from "./work-context.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000301" as ProjectId;
const THREAD_ID = "00000000-0000-4000-8000-000000000302" as ThreadId;
const WORK_ID = "00000000-0000-4000-8000-000000000303" as WorkId;
const NO_WORK_ID = "00000000-0000-4000-8000-000000000304" as WorkId;
const USER_ID = "00000000-0000-4000-8000-000000000305";

function work(overrides: Partial<Work> & Pick<Work, "id" | "name">): Work {
  return {
    projectId: PROJECT_ID,
    createdByUserId: USER_ID,
    slug: testWorkSlug(overrides.name.toLowerCase().replaceAll(" ", "-")),
    isNoWork: false,
    goal: null,
    status: null,
    archivedAt: null,
    aiWriteMode: "direct",
    entityRevision: "1",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    lastActivityAt: "2026-08-08T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("renderWorkContext", () => {
  it("tells the AI that the current archived Work is read-only", () => {
    const current = work({
      id: WORK_ID,
      name: "Arc",
      archivedAt: "2026-08-09T00:00:00.000Z",
    });

    expect(renderWorkContext({ current, activeWorks: [] })).toContain(
      "archived: this Work is read-only; use work unarchive before changing it.",
    );
  });

  it("bakes No Work current from the row's write mode", () => {
    const locked = work({
      id: NO_WORK_ID,
      name: "No Work",
      slug: null,
      isNoWork: true,
      aiWriteMode: "draft",
    });
    const named = work({
      id: WORK_ID,
      name: "Arc",
      lastActivityAt: "2026-08-09T00:00:00.000Z",
    });
    expect(renderWorkContext({ current: locked, activeWorks: [locked, named] })).toBe(
      [
        "<work_context>",
        "current: none (draft writes)",
        "active (most recent first; max 20):",
        '  arc: "Arc" (goal: none)',
        "</work_context>",
      ].join("\n"),
    );
  });

  it("keeps goal paragraphs intact while escaping prompt markup", () => {
    const current = work({
      id: WORK_ID,
      name: "Arc",
      goal: "Reach the mirror.\n\nDo not trust <echoes> & whispers.",
    });

    expect(renderWorkContext({ current, activeWorks: [current] })).toBe(
      [
        "<work_context>",
        'current: arc: "Arc"',
        "  goal: |",
        "    Reach the mirror.",
        "    ",
        "    Do not trust &lt;echoes&gt; &amp; whispers.",
        "active (most recent first; max 20):",
        "  none",
        "</work_context>",
      ].join("\n"),
    );
  });

  it("summarizes each other active Work in one escaped line", () => {
    const current = work({ id: WORK_ID, name: "Arc" });
    const other = work({
      id: NO_WORK_ID,
      name: "Pass",
      goal: "Secure <the> pass & hold\nbefore dawn.\n\nDo not follow the lights.",
    });

    expect(renderWorkContext({ current, activeWorks: [current, other] })).toBe(
      [
        "<work_context>",
        'current: arc: "Arc" (goal: none)',
        "active (most recent first; max 20):",
        '  pass: "Pass" (goal: Secure &lt;the&gt; pass &amp; hold before dawn.)',
        "</work_context>",
      ].join("\n"),
    );
  });

  it("renders bounded status for the current and other active Work", () => {
    const current = work({
      id: WORK_ID,
      name: "Arc",
      goal: "Finish chapter 14.",
      status: "Drafting",
    });
    const other = work({
      id: NO_WORK_ID,
      name: "Coda",
      goal: "Land the ending.",
      status: "Revising",
    });

    expect(renderWorkContext({ current, activeWorks: [current, other] })).toBe(
      [
        "<work_context>",
        'current: arc: "Arc"',
        "  status: Drafting",
        "  goal: |",
        "    Finish chapter 14.",
        "active (most recent first; max 20):",
        '  coda: "Coda" (status: Revising; goal: Land the ending.)',
        "</work_context>",
      ].join("\n"),
    );
  });

  it("marks goals truncated at the model-context limit", () => {
    const current = work({
      id: WORK_ID,
      name: "Arc",
      goal: "x".repeat(WORK_CONTEXT_GOAL_LIMIT + 40),
    });
    const rendered = renderWorkContext({ current, activeWorks: [current] });
    const marker = "… [truncated]";

    expect(rendered).toContain(`${"x".repeat(WORK_CONTEXT_GOAL_LIMIT - marker.length)}${marker}`);
    expect(rendered).not.toContain("x".repeat(WORK_CONTEXT_GOAL_LIMIT + 1));
  });

  it("bounds other active Work summaries to one line", () => {
    const current = work({ id: WORK_ID, name: "Arc" });
    const other = work({
      id: NO_WORK_ID,
      name: "Long Goal",
      goal: "s".repeat(WORK_CONTEXT_OTHER_GOAL_LIMIT + 40),
    });
    const rendered = renderWorkContext({ current, activeWorks: [current, other] });
    const marker = "…";
    const line = rendered.split("\n").find((candidate) => candidate.startsWith('  long-goal: "'));

    expect(line).toBe(
      `  long-goal: "Long Goal" (goal: ${"s".repeat(WORK_CONTEXT_OTHER_GOAL_LIMIT - marker.length)}${marker})`,
    );
    expect(line?.length).toBeLessThan(200);
    expect(rendered).not.toContain("s".repeat(WORK_CONTEXT_OTHER_GOAL_LIMIT + 1));
  });

  it("keeps truncation cuts on Unicode code point boundaries", () => {
    const currentMarker = "… [truncated]";
    const currentPrefix = "c".repeat(WORK_CONTEXT_GOAL_LIMIT - currentMarker.length - 1);
    const current = work({
      id: WORK_ID,
      name: "Arc",
      goal: `${currentPrefix}😀${"tail".repeat(20)}`,
    });
    const otherMarker = "…";
    const otherPrefix = "o".repeat(WORK_CONTEXT_OTHER_GOAL_LIMIT - otherMarker.length - 1);
    const other = work({
      id: NO_WORK_ID,
      name: "Other",
      goal: `${otherPrefix}😀${"tail".repeat(20)}`,
    });
    const rendered = renderWorkContext({ current, activeWorks: [current, other] });

    expect(rendered).toContain(`${currentPrefix}${currentMarker}`);
    expect(rendered).toContain(`${otherPrefix}${otherMarker}`);
  });

  it("truncates raw goal text before escaping ampersands", () => {
    const marker = "… [truncated]";
    const prefix = "g".repeat(WORK_CONTEXT_GOAL_LIMIT - marker.length - 1);
    const current = work({
      id: WORK_ID,
      name: "Arc",
      goal: `${prefix}&tail${"x".repeat(WORK_CONTEXT_GOAL_LIMIT)}`,
    });

    const rendered = renderWorkContext({ current, activeWorks: [current] });

    expect(rendered).toContain(`${prefix}&amp;${marker}`);
    expect(rendered).not.toContain("&a…");
  });
});

describe("createWorkContextReader", () => {
  it("treats a missing primary as corrupt", async () => {
    const reader = createWorkContextReader({
      threads: {
        findById: async () =>
          ({
            id: THREAD_ID,
            projectId: PROJECT_ID,
            deletedAt: null,
          }) as never,
      },
      works: {
        findById: async () => null,
        listByProject: async () => [],
      },
      threadWorks: { findPrimary: async () => null },
    });
    await expect(reader.renderForThread(THREAD_ID)).rejects.toThrow(
      `Thread primary Work is missing: ${THREAD_ID}`,
    );
  });
});
