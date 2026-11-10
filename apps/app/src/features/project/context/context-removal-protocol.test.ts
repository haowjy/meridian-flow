import { expect, it } from "vitest";
import {
  adoptReviewBinding,
  beginSelection,
  type ContextRouteSelection,
} from "./context-removal-protocol";

const locator = { scheme: "manuscript" as const, path: "/x.md" };
const bound = (by: "navigation" | "answer" | "review"): ContextRouteSelection => ({
  status: "bound",
  revision: 1,
  locator,
  identity: { kind: "server", documentId: "doc" },
  by,
});

it("Back from a review onto its path starts over, where a navigation's binding stays", () => {
  expect(beginSelection(bound("review"), locator).selection.status).toBe("candidate");
  expect(beginSelection(bound("navigation"), locator).selection.status).toBe("bound");
  expect(beginSelection(bound("answer"), locator).selection.status).toBe("bound");
});

it("a writer's exit from a review keeps the binding as a navigation's; other bindings are untouched", () => {
  expect(adoptReviewBinding(bound("review"))?.selection).toMatchObject({
    status: "bound",
    by: "navigation",
  });
  expect(adoptReviewBinding(bound("navigation"))).toBeNull();
});
