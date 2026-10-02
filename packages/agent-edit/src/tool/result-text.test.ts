// Pins the model's text for fixed typed results (D43).
import { describe, expect, it } from "vitest";
import { type AgentEditResultV1, modelResult } from "./model-result.js";
import { renderAgentEditResult } from "./result-text.js";

const item = (hash: string, body: string) => ({ hash, body });

describe("renderAgentEditResult", () => {
  it("renders a read as a status line and hashlines", () => {
    const result = modelResult({
      command: "read",
      status: "success",
      phase: "committed",
      payload: {
        path: "manuscript://chapter.md",
        read: { format: "full" },
        blocks: [
          {
            extent: "full",
            relation: "document",
            items: [
              item("a1b2", "# Chapter"),
              item("c3d4", "```text\nfirst line\nc3d4|looks like another block\n```"),
            ],
          },
        ],
      },
    });
    expect(renderAgentEditResult(result)).toBe(
      [
        "status: success; path: manuscript://chapter.md; blocks: 2",
        "",
        "a1b2|# Chapter",
        "c3d4|",
        "```text",
        "first line",
        "c3d4|looks like another block",
        "```",
      ].join("\n"),
    );
  });

  it("prints the call that reads each section under an outline heading", () => {
    const result = modelResult({
      command: "read",
      status: "success",
      phase: "committed",
      payload: {
        path: "chapter.md#arena",
        read: { format: "outline" },
        blocks: [
          {
            extent: "full",
            relation: "document",
            items: [item("a1b2", "# Chapter"), item("e5f6", "## Arena")],
          },
        ],
      },
    });
    expect(renderAgentEditResult(result)).toBe(
      [
        "status: success; path: chapter.md#arena; blocks: 2; format: outline",
        "",
        "a1b2|# Chapter",
        'read({"path": "chapter.md#a1b2"})',
        "e5f6|## Arena",
        'read({"path": "chapter.md#e5f6"})',
      ].join("\n"),
    );
  });

  it("renders a write's handle, removals, concurrent edits and sweeps before its echo", () => {
    const result = modelResult({
      command: "replace",
      status: "success",
      phase: "committed",
      payload: {
        path: "chapter.md",
        write: { id: "w3", deletedHashes: ["dead"] },
        blocks: [
          { extent: "prefix", relation: "context", items: [item("a1b2", "Before…")] },
          { extent: "full", relation: "changed", items: [item("c3d4", "Changed.")] },
          { extent: "full", relation: "swept", items: [item("beef", "Writer line.")] },
        ],
        concurrent: {
          runs: [
            {
              origin: "human",
              blocks: [item("c3d4", "Changed."), item("f00d", "Writer edit.")],
              tombstones: [{ hash: "0ld0", body: "Gone." }],
            },
          ],
          syncOverflow: true,
        },
        awarenessDegraded: true,
      },
    });
    expect(renderAgentEditResult(result)).toBe(
      [
        "status: success; path: chapter.md; write: w3",
        "removed: dead",
        "concurrent edits:",
        "  human:",
        "    f00d|Writer edit.",
        "    0ld0| [explicit deletion]",
        "Gone.",
        "sync_overflow: fresh bounded read required",
        "concurrent user content swept during commit; re-read required",
        "swept: beef|Writer line.",
        "destructive awareness degraded after durable recovery; re-read required",
        "",
        "a1b2|Before…",
        "c3d4|Changed.",
      ].join("\n"),
    );
  });

  it("renders the reversed write handles and an error message", () => {
    const undo = modelResult({
      command: "undo",
      status: "reversed",
      payload: { path: "chapter.md", reversal: { direction: "undo", writes: ["w2", "w3"] } },
    });
    expect(renderAgentEditResult(undo)).toBe("status: reversed; path: chapter.md; undo: w2, w3");
    const missing: AgentEditResultV1 = modelResult({
      command: "remove",
      status: "not_found",
      payload: { message: 'Block hash "dead" was not found.' },
    });
    expect(renderAgentEditResult(missing)).toBe(
      'status: not_found\n\nBlock hash "dead" was not found.',
    );
  });
});
