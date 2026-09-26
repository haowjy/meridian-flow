// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { latestSubagentBlockRevealTarget } from "./useTurnRevealLanding";

describe("subagent block reveal targeting", () => {
  it("selects the latest matching launch, finished, or report block in one turn", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div data-subagent-thread-id="child"></div>
      <div data-subagent-thread-id="other"></div>
      <div data-subagent-thread-id="child"></div>
    `;
    expect(latestSubagentBlockRevealTarget(row, "child")).toBe(row.lastElementChild);
    expect(latestSubagentBlockRevealTarget(row, "missing")).toBeUndefined();
  });
});
