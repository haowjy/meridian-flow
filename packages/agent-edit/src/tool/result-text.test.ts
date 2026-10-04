// One golden per renderer of the model's text for typed results (D43).
import { describe, expect, it } from "vitest";
import { modelResult } from "./model-result.js";
import { agentEditResultSummary, renderAgentEditResult } from "./result-text.js";

const item = (hash: string, body: string) => ({ hash, body });

describe("renderAgentEditResult", () => {
  it("keeps an outline's section reads on the live version it read", () => {
    const result = modelResult({
      command: "read",
      status: "success",
      phase: "committed",
      payload: {
        path: "chapter.md",
        read: { format: "outline", version: "live" },
        blocks: [{ extent: "full", relation: "document", items: [item("e5f6", "## Arena")] }],
      },
    });
    expect(renderAgentEditResult(result)).toBe(
      [
        "status: success; path: chapter.md; blocks: 1; version: live; format: outline",
        "",
        "e5f6|## Arena",
        'read({"path": "chapter.md#e5f6", "version": "live"})',
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
});

describe("agentEditResultSummary", () => {
  it("names a write's handle, the words it sent and the draft it changed", () => {
    const drafted = modelResult({
      command: "replace",
      status: "success",
      phase: "committed",
      payload: { write: { id: "w4" }, destination: "draft", draftWork: "rewrite" },
    });
    expect(agentEditResultSummary(drafted, 3)).toBe("w4, 3 words, version: draft (@rewrite)");
    expect(agentEditResultSummary({ ...drafted, destination: "live" }, 1)).toBe("w4, 1 word");
  });
});
