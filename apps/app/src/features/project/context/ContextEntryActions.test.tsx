// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextEntryMenu } from "./ContextEntryActions";

vi.mock("@/client/query/useDeleteContextEntry", () => ({
  useDeleteContextEntry: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

it("opens on right click and dispatches the selected action after the menu closes", async () => {
  const onAction = vi.fn();

  await withReactRoot(
    <ContextEntryMenu allowCreate onAction={onAction}>
      <button type="button">Chapter one</button>
    </ContextEntryMenu>,
    async () => {
      const trigger = document.querySelector("button");
      expect(trigger).not.toBeNull();

      await act(async () => {
        trigger?.dispatchEvent(
          new window.MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
        );
      });

      const rename = [...document.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent === "Rename",
      );
      expect(rename).toBeDefined();

      await act(async () => {
        rename?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });

      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(onAction).toHaveBeenCalledOnce();
      expect(onAction).toHaveBeenCalledWith("rename");
    },
  );
});
