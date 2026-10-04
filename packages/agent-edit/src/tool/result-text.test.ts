// Pins the model's text for fixed typed results (D43).
import { describe, expect, it } from "vitest";
import { type AgentEditResultV1, modelResult } from "./model-result.js";
import { agentEditResultSummary, renderAgentEditResult } from "./result-text.js";

const item = (hash: string, body: string) => ({ hash, body });

describe("renderAgentEditResult", () => {
  it("renders a read as a status line and hashlines", () => {
    const result = modelResult({
      command: "read",
      status: "success",
      phase: "committed",
      payload: {
        path: "manuscript://chapter.md",
        read: { format: "full", version: "draft" },
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
        "status: success; path: manuscript://chapter.md; blocks: 2; version: draft",
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
            items: [item("a1b2", "# Chapter"), { ...item("e5f6", "## Arena"), section: "arena" }],
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
        'read({"path": "chapter.md#arena"})',
      ].join("\n"),
    );
  });

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

  it("names the Work draft a drafted write landed in", () => {
    const write = (destination: "live" | "draft", draftWork?: string) =>
      renderAgentEditResult(
        modelResult({
          command: "insert",
          status: "success",
          phase: "staged",
          payload: {
            path: "kb://notes.md",
            write: { id: "w2" },
            destination,
            ...(draftWork === undefined ? {} : { draftWork }),
          },
        }),
      );
    expect(write("draft", "rewrite")).toBe(
      "status: success; path: kb://notes.md; write: w2 (drafted in @rewrite)",
    );
    expect(write("live")).toBe("status: success; path: kb://notes.md; write: w2");
  });

  it("says a reconciled undo kept later edits", () => {
    const undo = modelResult({
      command: "undo",
      status: "reconciled",
      payload: { path: "chapter.md", reversal: { direction: "undo", writes: ["w2"] } },
    });
    expect(renderAgentEditResult(undo)).toBe(
      [
        "status: reconciled; path: chapter.md; undo: w2",
        "later edits were kept, so the text may not match how it was before the write.",
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

describe("agentEditResultSummary", () => {
  const read = (documentBlocks: number | undefined, items: number) =>
    modelResult({
      command: "read",
      status: "success",
      phase: "committed",
      payload: {
        path: "manuscript://chapter-11.md",
        read: { format: "outline", ...(documentBlocks ? { documentBlocks } : {}) },
        blocks: [
          {
            extent: "full",
            relation: "document",
            items: Array.from({ length: items }, (_, i) => item(`h${i}`, `# ${i}`)),
          },
        ],
      },
    });

  it("counts a read's blocks, out of the document's when it returned fewer", () => {
    expect(agentEditResultSummary(read(62, 5))).toBe("5 of 62 blocks");
    expect(agentEditResultSummary(read(undefined, 1))).toBe("1 block");
  });

  it("names a write's handle, the words it sent and where it drafted", () => {
    const drafted = modelResult({
      command: "replace",
      status: "success",
      phase: "committed",
      payload: { write: { id: "w4" }, destination: "draft", draftWork: "rewrite" },
    });
    expect(agentEditResultSummary(drafted, 3)).toBe("w4, 3 words, drafted in @rewrite");
    expect(agentEditResultSummary({ ...drafted, destination: "live" }, 1)).toBe("w4, 1 word");
  });

  it("says what a copy and an undo did, and a status that isn't plain success", () => {
    expect(
      agentEditResultSummary(
        modelResult({
          command: "copy",
          status: "success",
          phase: "committed",
          payload: { write: { id: "w2" }, copied: { from: "ch11.md", blocks: 3 } },
        }),
      ),
    ).toBe("w2, copied 3 blocks");
    expect(
      agentEditResultSummary(
        modelResult({
          command: "undo",
          status: "reconciled",
          payload: { reversal: { direction: "undo", writes: ["w3", "w4"] } },
        }),
      ),
    ).toBe("reconciled, undo: w3, w4");
    expect(
      agentEditResultSummary(modelResult({ command: "undo", status: "nothing_to_undo" })),
    ).toBe("nothing_to_undo");
  });
});
