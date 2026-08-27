// @vitest-environment jsdom
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { InlineErrorRow } = await import("./InlineErrorRow");

describe("InlineErrorRow", () => {
  it("announces a dynamically inserted failure and keeps Retry focusable after its message", async () => {
    function Harness() {
      const [failed, setFailed] = useState(false);
      return failed ? (
        <InlineErrorRow message="Could not save" onRetry={() => undefined} />
      ) : (
        <button type="button" onClick={() => setFailed(true)}>
          Fail
        </button>
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(document.querySelector('[role="alert"]')).toBeNull();

      act(() => document.querySelector<HTMLButtonElement>("button")?.click());

      const alert = document.querySelector<HTMLElement>('[role="alert"]');
      const message = Array.from(alert?.querySelectorAll("span") ?? []).find(
        (element) => element.textContent === "Could not save",
      );
      const retry = Array.from(alert?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Retry",
      );
      expect(alert?.textContent).toContain("Could not save");
      expect(message).toBeDefined();
      expect(retry).toBeDefined();
      if (!message || !retry) throw new Error("expected an alert message followed by Retry");
      expect(message.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );

      retry?.focus();
      expect(document.activeElement).toBe(retry);
    });
  });
});
