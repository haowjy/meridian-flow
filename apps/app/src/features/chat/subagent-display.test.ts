import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
}));

import {
  formatSubagentElapsed,
  resolveSubagentName,
  subagentCurrentToolLabel,
  subagentStatus,
} from "./subagent-display";

describe("subagent display", () => {
  it("resolves one identity from profile, then title, then fallback", () => {
    expect(resolveSubagentName({ agentName: "  Scout  ", title: "Long task" })).toBe("Scout");
    expect(resolveSubagentName({ agentName: null, title: "Long task" })).toBe("Long task");
    expect(resolveSubagentName({ agentName: null, title: null })).toBe("Subagent");
  });

  it("maps every terminal result through the shared status vocabulary", () => {
    expect(subagentStatus("succeeded")).toBe("done");
    expect(subagentStatus("cancelled")).toBe("stopped");
    expect(subagentStatus("failed")).toBe("stopped");
    expect(subagentStatus(undefined, true)).toBe("running");
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
    expect(subagentCurrentToolLabel("search", { pattern: "lantern" })).toContain("Searching");
    expect(subagentCurrentToolLabel("spawn", { agent: "Reader" })).toContain("Waiting on Reader");
  });
});
