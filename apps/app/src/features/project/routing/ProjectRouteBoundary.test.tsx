// @vitest-environment jsdom
/** A pending document switch must not hide the last usable editor or block newer navigation. */
import { act, type ReactNode, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ProjectRouteBoundary, type ProjectRouteIssue } from "./ProjectRouteBoundary";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

it("keeps a retained editor visible during loading but masks unavailable content", async () => {
  let change!: (issue: ProjectRouteIssue | undefined) => void;
  function Harness() {
    const [issue, setIssue] = useState<ProjectRouteIssue>();
    change = setIssue;
    return (
      <ProjectRouteBoundary issue={issue} retainWhileLoading>
        <textarea defaultValue="Local words" />
      </ProjectRouteBoundary>
    );
  }
  await withReactRoot(<Harness />, async () => {
    const editor = document.querySelector("textarea");
    expect(editor).not.toBeNull();
    if (!editor) throw new Error("Editor did not mount");
    await act(async () => change("loading"));
    expect(document.querySelector("textarea")).toBe(editor);
    expect(editor.closest('[aria-hidden="true"]')).toBeNull();
    expect(editor.closest("[inert]")).toBeNull();
    expect(document.body.textContent).not.toContain("Loading destination");
    for (const issue of ["unavailable", "error"] as const) {
      await act(async () => change(issue));
      expect(editor.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    await act(async () => change(undefined));
    expect(editor.value).toBe("Local words");
    expect(editor.closest('[aria-hidden="true"]')).toBeNull();
  });
});

afterEach(() => vi.useRealTimers());

it("delays cold feedback per destination and never replaces retained content with feedback", async () => {
  vi.useFakeTimers();
  let change!: (next: { key: string; issue?: ProjectRouteIssue; retain?: boolean }) => void;
  function Harness() {
    const [state, setState] = useState<{
      key: string;
      issue?: ProjectRouteIssue;
      retain?: boolean;
    }>({ key: "a", issue: "loading" });
    change = setState;
    return (
      <ProjectRouteBoundary
        issue={state.issue}
        destinationKey={state.key}
        retainWhileLoading={state.retain}
      >
        <textarea defaultValue="Local words" />
      </ProjectRouteBoundary>
    );
  }
  await withReactRoot(<Harness />, async () => {
    const skeleton = () => document.querySelector('[data-slot="skeleton"]');
    const editor = document.querySelector("textarea");
    if (!editor) throw new Error("Editor did not mount");
    expect(document.body.textContent).not.toContain("Loading destination");
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(editor.closest('[aria-hidden="true"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(499));
    expect(skeleton()).toBeNull();
    await act(async () => change({ key: "b", issue: "loading" }));
    await act(async () => vi.advanceTimersByTime(499));
    expect(skeleton()).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(skeleton()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1500));
    expect(skeleton()).not.toBeNull();
    expect(document.querySelector("svg")).toBeNull();
    await act(async () => change({ key: "a", issue: "loading" }));
    expect(skeleton()).toBeNull();
    await act(async () => change({ key: "a" }));
    expect(editor.closest('[aria-hidden="true"]')).toBeNull();
    expect(document.querySelector("textarea")).toBe(editor);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(skeleton()).toBeNull();
    await act(async () => change({ key: "c", issue: "loading", retain: true }));
    await act(async () => vi.advanceTimersByTime(2000));
    expect(skeleton()).toBeNull();
    expect(editor.closest('[aria-hidden="true"]')).toBeNull();
    expect(document.querySelector("svg")).toBeNull();
    expect(document.body.textContent).not.toContain("Loading destination");
  });
});
