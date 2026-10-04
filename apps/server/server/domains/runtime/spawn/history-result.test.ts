/**
 * Rendering cases the history contract suites don't reach: the succeeded
 * report label, thinking and cancelled items, and refusals. The contract pins
 * the rest of the format end to end (D10, D48).
 */
import { describe, expect, it } from "vitest";
import {
  type HistoryResult,
  type HistoryTurn,
  renderHistoryResult,
  renderThreadHistoryOutput,
} from "./history-result.js";

const turn = (overrides: Partial<HistoryTurn> & Pick<HistoryTurn, "number">): HistoryTurn => ({
  role: "assistant",
  label: "assistant",
  items: [],
  hiddenCount: 0,
  ...overrides,
});

describe("renderHistoryResult", () => {
  it("renders a saved report in place of the child's return_result, cut to its first lines", () => {
    const text = renderHistoryResult({
      ref: "c2",
      view: "page",
      turns: [
        turn({
          number: 6,
          hiddenCount: 1,
          report: {
            outcome: "succeeded",
            source: "return_result",
            reason: null,
            partial: false,
            content: "The conversation so far covers three topics: ...",
            truncated: true,
          },
        }),
      ],
      inProgress: [],
    });
    expect(text).toBe(`Conversation c2

[6] assistant
Report (completed)
The conversation so far covers three topics: ...
(report truncated: thread_history({"ref":"c2","expand":6}))
(1 routine tool call hidden; list it with thread_history({"ref":"c2","expand":6}))`);
  });

  it("lists an expanded turn one line per item, with sizes and handles", () => {
    const text = renderHistoryResult({
      ref: "c2",
      view: "turn",
      turns: [
        turn({
          number: 4,
          items: [
            { kind: "thinking", index: 1, tokens: 320 },
            { kind: "message", index: 2, text: "Checking chapter eleven.", tokens: 6 },
            {
              kind: "tool",
              index: 3,
              tool: "read",
              args: { path: "manuscript://chapter-11.md", format: "outline" },
              state: "done",
              summary: "5 of 62 blocks",
              resultTokens: 5120,
            },
            { kind: "tool", index: 4, tool: "ls", args: {}, state: "cancelled" },
          ],
        }),
      ],
      inProgress: [],
    });
    expect(text).toBe(`Conversation c2

[4] assistant
4.1 thinking (320 tokens)
4.2 Checking chapter eleven.
4.3 read({"path":"manuscript://chapter-11.md","format":"outline"}) → 5 of 62 blocks (5,120 tokens)
4.4 ls({}) → cancelled`);
  });

  it("renders a refusal as its message and code, not JSON", () => {
    const refusal = { code: "item_not_found", message: "Turn 9 not found in c2" };
    expect(renderThreadHistoryOutput(refusal)).toBe("Turn 9 not found in c2 (item_not_found)");
  });
});
