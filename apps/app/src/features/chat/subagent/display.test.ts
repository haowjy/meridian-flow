import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
}));

import {
  formatSubagentElapsed,
  resolveSubagentName,
  subagentCurrentToolLabel,
  subagentDescription,
  subagentMarkName,
  subagentStatus,
} from "./display";

describe("subagent display", () => {
  it("leads with the agent name and keeps the description separate", () => {
    expect(resolveSubagentName({ agentName: "  Scout  ", title: "Long task" })).toBe("Scout");
    expect(resolveSubagentName({ agentName: null, title: "Long task" })).toBe("Subagent");
    expect(subagentDescription({ agentName: null, title: " Long task " })).toBe("Long task");
    expect(subagentDescription({ agentName: "Scout", title: "Scout" })).toBeNull();
    expect(subagentDescription({ agentName: "Scout", title: null })).toBeNull();
  });

  it("uses agent identity for marks instead of falling back to the task title", () => {
    expect(subagentMarkName("  Scout  ")).toBe("Scout");
    expect(subagentMarkName(null)).toBe("Subagent");
    expect(subagentMarkName("   ")).toBe("Subagent");
    expect(subagentMarkName("Subagent")).toBe("Subagent");
  });

  it("maps every terminal result through the shared status vocabulary", () => {
    expect(subagentStatus("succeeded")).toBe("done");
    expect(subagentStatus("cancelled")).toBe("stopped");
    expect(subagentStatus("failed")).toBe("stopped");
    expect(subagentStatus(undefined, true)).toBe("running");
    expect(subagentStatus(undefined)).toBe("unknown");
  });

  it("formats a deterministic elapsed duration", () => {
    expect(
      formatSubagentElapsed(
        "2026-09-26T10:00:00.000Z",
        null,
        Date.parse("2026-09-26T10:00:08.000Z"),
      ),
    ).toBe("8s");
    expect(
      formatSubagentElapsed(
        "2026-09-26T10:00:00.000Z",
        null,
        Date.parse("2026-09-26T10:01:04.000Z"),
      ),
    ).toBe("1:04");
    expect(formatSubagentElapsed("not-a-date", null, 0)).toBe("");
  });

  it("uses the process-fold tool vocabulary for live calls", () => {
    expect(subagentCurrentToolLabel("search", { query: "lantern" })).toContain("Searching");
    expect(subagentCurrentToolLabel("spawn", { agent: "Reader" })).toContain("Waiting on Reader");
    expect(
      subagentCurrentToolLabel("write", { command: "read", path: "manuscript://chapter-1.md" }),
    ).toBe("Reading chapter-1.md…");
    expect(subagentCurrentToolLabel("write", { path: "manuscript://story-b.md" })).toBe(
      "Writing story-b.md…",
    );
    expect(subagentCurrentToolLabel("edit", { path: "manuscript://story-b.md" })).toBe(
      "Editing story-b.md…",
    );
    expect(subagentCurrentToolLabel("read", { uri: "manuscript://story-a.md" })).toBe(
      "Reading story-a.md…",
    );
    expect(subagentCurrentToolLabel("search", null)).toBe("Searching…");
    expect(subagentCurrentToolLabel("spawn", null)).toContain("Waiting on");
    expect(subagentCurrentToolLabel("write", null)).toBe("Writing…");
  });
});
