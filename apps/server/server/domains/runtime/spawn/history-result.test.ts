/** The history text is a pure rendering of `HistoryResult`; fixtures pin the agreed format (D10). */
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
  it("renders the pizza conversation verbatim", () => {
    const pizza: HistoryResult = {
      ref: "c2",
      view: "page",
      turns: [
        turn({
          number: 1,
          role: "user",
          label: "user",
          items: [{ kind: "message", text: "pizza", tokens: 2 }],
        }),
        turn({
          number: 2,
          items: [
            {
              kind: "message",
              text: 'I looked around to see what "pizza" might point at, ...',
              tokens: 14,
            },
          ],
          hiddenCount: 10,
        }),
        turn({
          number: 3,
          role: "user",
          label: "user",
          items: [
            {
              kind: "message",
              text: "can u test a subagent using from and ask it to summarize the conversation so far",
              tokens: 18,
            },
          ],
        }),
      ],
      inProgress: [
        turn({
          number: 4,
          items: [
            {
              kind: "tool",
              tool: "spawn",
              args: { agent: "general", name: "Summarize conversation test" },
              state: "running",
            },
          ],
        }),
      ],
    };
    expect(renderHistoryResult(pizza)).toBe(`Conversation c2

[1] user
pizza

[2] assistant
I looked around to see what "pizza" might point at, ...
(10 routine tool calls hidden; list them with thread_history({"ref":"c2","expand":2}))

[3] user
can u test a subagent using from and ask it to summarize the conversation so far

In progress
[4] spawn({"agent":"general","name":"Summarize conversation test"}) → running`);
  });

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

  it("adds a reason line only when the report has one", () => {
    const text = renderHistoryResult({
      ref: "p3",
      view: "page",
      turns: [
        turn({
          number: 2,
          report: {
            outcome: "failed",
            source: "final_assistant",
            reason: "blocked at the gate",
            partial: true,
            content: "Stopped early.",
          },
        }),
      ],
      inProgress: [],
    });
    expect(text).toContain(
      "Report (failed, final_assistant)\nreason: blocked at the gate\nStopped early.",
    );
  });

  it("marks compaction, prints handles as copyable calls and keeps the continuation", () => {
    const text = renderHistoryResult({
      ref: "c2",
      view: "page",
      turns: [
        turn({
          number: 37,
          summarizedBefore: true,
          role: "user",
          label: "user",
          at: "2026-10-01 14:03",
          items: [
            { kind: "message", index: 1, text: "A long request", tokens: 5000, truncated: true },
          ],
        }),
        turn({
          number: 38,
          items: [
            {
              kind: "tool",
              tool: "write",
              args: {
                command: "replace",
                path: "ch3.md",
                content: "The moon was low over the ridge…(212 words)",
                find: "The moon was",
              },
              state: "done",
              summary: "w4, 212 words, drafted in @rewrite",
            },
            {
              kind: "tool",
              tool: "read",
              args: { path: "skill://story-review/resources/developmental-edit.md" },
              state: "error",
              summary: "document_not_found",
            },
            {
              kind: "tool",
              tool: "spawn",
              args: {
                agent: "critic",
                prompt: "Load the story-review skill…(310 words)",
                name: "Pacing review",
              },
              state: "done",
              summary: "p8",
            },
            {
              kind: "tool",
              tool: "work",
              args: { command: "create", name: "Rewrite" },
              state: "done",
              summary: "@rewrite",
            },
          ],
        }),
      ],
      inProgress: [],
      next: { call: { ref: "c2", cursor: "c2:n37@40~abcdef12", include: ["thinking"] } },
    });
    expect(text).toBe(`Conversation c2

[earlier turns summarized]

[37] user  2026-10-01 14:03
A long request
(truncated: thread_history({"ref":"c2","expand":"37.1"}))

[38] assistant
write({"command":"replace","path":"ch3.md","content":"The moon was low over the ridge…(212 words)","find":"The moon was"}) → w4, 212 words, drafted in @rewrite
read({"path":"skill://story-review/resources/developmental-edit.md"}) → failed: document_not_found
spawn({"agent":"critic","prompt":"Load the story-review skill…(310 words)","name":"Pacing review"}) → p8
work({"command":"create","name":"Rewrite"}) → @rewrite

More: thread_history({"ref":"c2","cursor":"c2:n37@40~abcdef12","include":["thinking"]})`);
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

  it("shows one call in full under its line: the arguments, then the result", () => {
    const text = renderHistoryResult({
      ref: "c2",
      view: "item",
      turns: [
        turn({
          number: 4,
          items: [
            {
              kind: "tool",
              index: 3,
              tool: "read",
              args: { path: "manuscript://ch2.md" },
              state: "done",
              summary: "3 blocks",
              fullArgs: '{"path":"manuscript://ch2.md"}',
              result: "status: success; path: manuscript://ch2.md; blocks: 3",
            },
          ],
        }),
      ],
      inProgress: [],
    });
    expect(text).toBe(`Conversation c2

[4] assistant
4.3 read({"path":"manuscript://ch2.md"}) → 3 blocks
{"path":"manuscript://ch2.md"}
status: success; path: manuscript://ch2.md; blocks: 3`);
  });

  it("renders a refusal as its message and code, not JSON", () => {
    const refusal = { code: "item_not_found", message: "Turn 9 not found in c2" };
    expect(renderThreadHistoryOutput(refusal)).toBe("Turn 9 not found in c2 (item_not_found)");
  });
});
