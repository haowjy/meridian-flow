// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./context-menu";

it("opens from the native context-menu gesture and exposes canonical menu slots", async () => {
  const selected = vi.fn();

  await withReactRoot(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">Chapter one</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={selected}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
    async () => {
      const trigger = document.querySelector("button");
      expect(trigger).not.toBeNull();

      await act(async () => {
        trigger?.dispatchEvent(
          new window.MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
        );
      });

      const content = document.querySelector('[data-slot="context-menu-content"]');
      const items = document.querySelectorAll('[data-slot="context-menu-item"]');
      expect(content).not.toBeNull();
      expect(items).toHaveLength(2);
      expect(items[1]?.getAttribute("data-variant")).toBe("destructive");
      expect(document.querySelector('[data-slot="context-menu-separator"]')).not.toBeNull();

      await act(async () => {
        items[0]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      expect(selected).toHaveBeenCalledOnce();
    },
  );
});
