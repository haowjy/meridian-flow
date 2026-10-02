// @vitest-environment jsdom

import type { ModelThreadReportResult } from "@meridian/contracts/spawn";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/rich-content/Markdown", () => ({
  Markdown: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { toolView } from "./report-test-fixtures";
import { readThreadReport, THREAD_REPORT_RENDERER } from "./thread-report-renderer";
import { isToolViewVisible } from "./tool-view-visibility";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const finished: ModelThreadReportResult = {
  ref: "p3",
  outcome: "succeeded",
  summary: "Done",
  artifacts: [{ type: "object", uri: "scratch://story.md" }],
};

function reportTool(result: ModelThreadReportResult, isError = false) {
  return toolView({
    toolCallId: "report-1",
    toolName: "thread_report",
    input: { ref: "p3" },
    // The model's text never parses as a report; the row reads only the typed result.
    output: "p3 succeeded.\n\nDone",
    result,
    isError,
  });
}

function renderExpand(result: ModelThreadReportResult): HTMLElement {
  const expand = THREAD_REPORT_RENDERER.expand?.(reportTool(result));
  if (!expand) throw new Error("expected an expandable report");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(expand()));
  return container;
}

describe("thread_report presentation", () => {
  it("shows as a fold step", () => {
    expect(
      isToolViewVisible(
        toolView({ toolCallId: "report-1", toolName: "thread_report", output: null }),
      ),
    ).toBe(true);
  });

  it("reads the finished report from the typed result", () => {
    expect(readThreadReport(finished)).toEqual({
      report: {
        outcome: "succeeded",
        summary: "Done",
        artifacts: [{ type: "object", uri: "scratch://story.md" }],
        partial: false,
        reason: null,
      },
      runningAgain: false,
    });
    expect(readThreadReport("p3 succeeded.\n\nDone")).toBeNull();
  });

  it("reads nothing for a report that isn't ready or a refusal", () => {
    const notReady: ModelThreadReportResult = {
      ref: "p3",
      status: "unavailable",
      message: "p3 has no finished report yet.",
    };
    expect(readThreadReport(notReady)).toBeNull();
    expect(THREAD_REPORT_RENDERER.expand?.(reportTool(notReady))).toBeNull();
    const refusal = {
      code: "thread_not_connected",
      message: "Not connected",
      source: "system",
      retryable: false,
    };
    expect(readThreadReport(refusal)).toBeNull();
  });

  it("says a report is from the previous run when the subagent is running again", () => {
    const running: ModelThreadReportResult = {
      ...finished,
      running: true,
      message: "p3 is running again; this report is from its previous run.",
    };
    expect(readThreadReport(running)?.runningAgain).toBe(true);
    const text = renderExpand(running).textContent ?? "";
    expect(text).toContain("Done");
    expect(text).toContain("This report is from its previous run. It's running again now.");
    expect(text).not.toContain("p3 is running again");
  });

  it("shows a finished report without the running line", () => {
    expect(renderExpand(finished).textContent).not.toContain("previous run");
  });
});
