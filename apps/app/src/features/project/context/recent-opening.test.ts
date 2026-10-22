/** A draft-only review is no live document: it must never become an account-recents opening. */
import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { recentOpening } from "./recent-opening";

const tab = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "manuscript",
  path: "/Chapter",
  name: "Chapter",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} as ContextTab;

describe("recentOpening", () => {
  it("opens a live document and refuses a draft-only review", () => {
    expect(recentOpening("p", tab, "now")?.documentId).toBe("doc-1");
    expect(
      recentOpening(
        "p",
        { ...tab, reviews: { w: { itemKey: "i", tabInstanceToken: "t" } } } as ContextTab,
        "now",
      ),
    ).toBeNull();
  });
});
