// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({ t: (strings: TemplateStringsArray) => strings[0] }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import type { ToolView } from "./group-delivery-segments";
import { ToolRow } from "./ToolRow";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("thread_report tool row", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("previews the first report line and expands to the complete result", async () => {
    const tool: ToolView = {
      toolCallId: "call-1",
      toolName: "thread_report",
      input: { ref: "p3", execution: "execution-1" },
      output: {
        ref: "p3",
        execution: "execution-1",
        outcome: "succeeded",
        source: "explicit",
        summary: "First line.\nFull report.",
        partial: false,
        reason: null,
      },
      status: "complete",
      isError: false,
      message: null,
      streamedOutput: null,
      metadata: null,
      keyBlock: {
        id: "tool-call",
        turnId: "turn-1",
        responseId: null,
        blockType: "tool_use",
        sequence: 1,
        content: { toolCallId: "call-1", toolName: "thread_report" },
        status: "complete",
        textContent: null,
        createdAt: "2026-09-23T00:00:00.000Z",
      },
    };
    await act(async () => root.render(<ToolRow tool={tool} />));

    expect(host.textContent).toContain("First line.");
    expect(host.textContent).not.toContain("Full report.");
    const toggle = host.querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    expect(host.textContent).toContain("Full report.");
  });

  it("uses explicit empty and failure copy instead of inventing a report", async () => {
    const tool = (outcome: "succeeded" | "failed") => ({
      toolCallId: "call-2",
      toolName: "thread_report",
      input: null,
      output: {
        ref: "p3",
        execution: "execution-2",
        outcome,
        source: "empty",
        summary: "",
        partial: outcome !== "succeeded",
        reason: outcome === "failed" ? "budget_exhausted" : null,
      },
      status: "complete" as const,
      isError: false,
      message: null,
      streamedOutput: null,
      metadata: null,
      keyBlock: {
        id: "tool-call-2",
        turnId: "turn-1",
        responseId: null,
        blockType: "tool_use" as const,
        sequence: 2,
        content: { toolCallId: "call-2", toolName: "thread_report" },
        status: "complete" as const,
        textContent: null,
        createdAt: "2026-09-23T00:00:00.000Z",
      },
    });
    await act(async () => root.render(<ToolRow tool={tool("succeeded")} />));
    expect(host.textContent).toContain("No report text was returned");
    await act(async () => root.render(<ToolRow tool={tool("failed")} />));
    expect(host.textContent).toContain("budget_exhausted");
  });
});
