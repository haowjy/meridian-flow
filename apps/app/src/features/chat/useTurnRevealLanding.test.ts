// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { subagentBlockRevealTarget, toolCallRevealTarget } from "./useTurnRevealLanding";

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

describe("tool call reveal targeting", () => {
  const turn = (open: boolean) => {
    const row = document.createElement("div");
    row.innerHTML = `
      <button data-tool-call-ids="call-1 call-2" id="fold"></button>
      <div data-process-fold aria-hidden="${open ? "false" : "true"}">
        <div data-tool-call-id="call-1" id="row-1"></div>
        <div data-tool-call-id="call-2" id="row-2"></div>
      </div>
    `;
    return row;
  };

  it("lands on the exact row when its fold is open", () => {
    expect(toolCallRevealTarget(turn(true), "call-2")?.id).toBe("row-2");
  });

  it("lands on the closed fold, not the hidden row", () => {
    expect(toolCallRevealTarget(turn(false), "call-2")?.id).toBe("fold");
  });

  it("finds nothing for a call the turn does not hold, leaving the landing on the turn", () => {
    expect(toolCallRevealTarget(turn(false), "call-9")).toBeUndefined();
  });
});
