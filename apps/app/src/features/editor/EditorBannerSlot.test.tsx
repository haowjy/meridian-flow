import { act, useState } from "react";
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

  it("treats a false conditional tenant as inactive", async () => {
    const condition = false;

    await withReactRoot(
      <EditorBannerSlot
        tenants={[
          {
            name: "conditional",
            // @ts-expect-error The public API rejects false; selection remains defensive at runtime.
            content: condition && <div data-tenant="conditional" />,
          },
          { name: "lower", content: <div data-tenant="lower" /> },
        ]}
      />,
      () => expect(document.querySelector("[data-tenant=lower]")).not.toBeNull(),
    );
  });

  it("resets local state when occupancy switches between same-type tenants", async () => {
    function StatefulTenant({ name }: { name: string }) {
      const [initialName] = useState(name);
      return <div data-initial-name={initialName}>{name}</div>;
    }

    function Harness() {
      const [highIsActive, setHighIsActive] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setHighIsActive(true)}>
            Activate high tenant
          </button>
          <EditorBannerSlot
            tenants={[
              {
                name: "high",
                content: highIsActive ? <StatefulTenant name="high" /> : null,
              },
              { name: "low", content: <StatefulTenant name="low" /> },
            ]}
          />
        </>
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(document.querySelector("[data-initial-name=low]")?.textContent).toBe("low");

      await act(async () => {
        document.querySelector("button")?.click();
      });

      expect(document.querySelector("[data-initial-name=high]")?.textContent).toBe("high");
      expect(document.querySelector("[data-initial-name=low]")).toBeNull();
    });
  });
});
