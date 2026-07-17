import { describe, expect, it } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { EditorBannerSlot } from "./EditorBannerSlot";

describe("EditorBannerSlot", () => {
  it("renders only the highest-priority active tenant", async () => {
    await withReactRoot(
      <EditorBannerSlot
        tenants={[
          { name: "highest", content: <div data-tenant="highest" /> },
          { name: "lower", content: <div data-tenant="lower" /> },
        ]}
      />,
      () => {
        expect(document.querySelector("[data-tenant=highest]")).not.toBeNull();
        expect(document.querySelector("[data-tenant=lower]")).toBeNull();
      },
    );
  });

  it("yields to the next tenant when a higher-priority tenant is inactive", async () => {
    await withReactRoot(
      <EditorBannerSlot
        tenants={[
          { name: "highest", content: null },
          { name: "lower", content: <div data-tenant="lower" /> },
        ]}
      />,
      () => expect(document.querySelector("[data-tenant=lower]")).not.toBeNull(),
    );
  });
});
