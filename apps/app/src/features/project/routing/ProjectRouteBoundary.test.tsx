// @vitest-environment jsdom
/** A pending document switch must not hide the last usable editor or block newer navigation. */
import { act, type ReactNode, useState } from "react";
import { expect, it, vi } from "vitest";
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
