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

it.each([
  "unavailable",
  "error",
  "resource-viewing",
  "loading",
] as const)("%s masks the destination body, not its address navigation", async (issue) => {
  const onNavigate = vi.fn();
  await withReactRoot(
    <ProjectRouteBoundary
      issue={issue}
      chrome={
        <nav aria-label="Address navigation">
          <button type="button" onClick={onNavigate}>
            Files
          </button>
        </nav>
      }
    >
      <p>document body</p>
    </ProjectRouteBoundary>,
    async () => {
      const nav = document.querySelector('nav[aria-label="Address navigation"]');
      expect(nav).not.toBeNull();
      expect(nav?.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(document.querySelector("[inert]")?.textContent).toBe("document body");
      await act(async () => nav?.querySelector("button")?.click());
      expect(onNavigate).toHaveBeenCalledOnce();
    },
  );
});
