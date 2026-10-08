// @vitest-environment jsdom
/** A failed destination offers the retry it is given; a loading or unavailable one does not. */
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ProjectRouteBoundary } from "./ProjectRouteBoundary";

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
