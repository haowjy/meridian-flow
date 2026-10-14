// @vitest-environment jsdom
/** A failed destination offers the retry it is given; a loading or unavailable one does not. */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { mergeSurfaceLayout, placeSurfaces } from "../layout/placement";
import { DEFAULT_SURFACE_PREFS } from "../layout/surface-prefs-store";
import { isProjectRouteMasked, ProjectRouteBoundary } from "./ProjectRouteBoundary";

const retryButton = () =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === "Retry");

it("shows the failure with a retry, keeping the destination's own content mounted but inert", async () => {
  const onRetry = vi.fn();
  await withReactRoot(
    <ProjectRouteBoundary issue="error" onRetry={onRetry}>
      <p>destination</p>
    </ProjectRouteBoundary>,
    async () => {
      expect(document.body.textContent).toContain("This destination couldn’t load.");
      expect(document.querySelector("[inert]")?.textContent).toBe("destination");
      await act(async () => retryButton()?.click());
      expect(onRetry).toHaveBeenCalledOnce();
    },
  );
});

// The shell uses the same masking decision as the body when applying review's rail hold.
it.each([
  { issue: "loading", recovery: undefined, collapsed: true },
  { issue: "loading", recovery: <p>Work recovery</p>, collapsed: false },
] as const)("review rail follows body masking: $issue, recovery=$recovery", async ({
  issue,
  recovery,
  collapsed,
}) => {
  const boundary = { issue, recovery, retainWhileLoading: true };
  const layout = mergeSurfaceLayout(
    placeSurfaces("context"),
    { ...DEFAULT_SURFACE_PREFS, threads: { width: 264, collapsed: false } },
    undefined,
    isProjectRouteMasked(boundary) ? [] : ["rail-l"],
  );
  await withReactRoot(
    <ProjectRouteBoundary {...boundary}>
      <p>review prose</p>
    </ProjectRouteBoundary>,
    () => {
      expect(document.querySelector("[inert]") === null).toBe(collapsed);
      expect(layout.threads.collapsed).toBe(collapsed);
    },
  );
});
