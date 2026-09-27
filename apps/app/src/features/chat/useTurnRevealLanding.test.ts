// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { subagentBlockRevealTarget } from "./useTurnRevealLanding";

describe("subagent block reveal targeting", () => {
  it("selects the latest matching launch, finished, or report block in one turn", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div data-subagent-thread-id="child"></div>
      <div data-subagent-thread-id="other"></div>
      <div data-subagent-thread-id="child"></div>
    `;
    expect(subagentBlockRevealTarget(row, "child")).toBe(row.lastElementChild);
    expect(subagentBlockRevealTarget(row, "missing")).toBeUndefined();
  });

  it("lands on the launch card when asked, even after a later finished line", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div data-subagent-card data-subagent-thread-id="child" id="card"></div>
      <div data-subagent-finished data-subagent-thread-id="child"></div>
    `;
    expect(subagentBlockRevealTarget(row, "child", "card")?.id).toBe("card");
  });
});
