// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";

import { MeridianApiError } from "@/client/api/http-client";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextEntryMenu, DeleteConfirmationDialog } from "./ContextEntryActions";

vi.mock("@/client/query/useDeleteContextEntry", () => ({
  useDeleteContextEntry: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

it("opens on right click and dispatches the selected action after the menu closes", async () => {
  const onAction = vi.fn();

  await withReactRoot(
    <ContextEntryMenu allowCreate allowDelete onAction={onAction}>
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

      await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
      await vi.waitFor(() => expect(onAction).toHaveBeenCalledOnce());
      expect(onAction).toHaveBeenCalledWith("rename");
    },
  );
});

it("exposes no generic delete action when the source owns deletion", async () => {
  await withReactRoot(
    <ContextEntryMenu allowCreate={false} allowDelete={false} onAction={vi.fn()}>
      <button type="button">Upload</button>
    </ContextEntryMenu>,
    async () => {
      const trigger = document.querySelector("button");
      await act(async () => {
        trigger?.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
      });

      const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      );
      expect(labels).toEqual(["Rename"]);
    },
  );
});

it.each([
  {
    error: new MeridianApiError({
      code: "stale_target",
      message: "The context entry changed. Refresh and try again.",
      retryable: true,
      source: "system" as const,
    }),
    message: "The entry changed. Refresh the tree and try again.",
  },
  {
    error: new Error("network failed"),
    message: "Couldn't delete this entry. Try again.",
  },
])("maps a delete failure to writer-facing recovery: $message", async ({ error, message }) => {
  await withReactRoot(
    <DeleteConfirmationDialog
      target={{ kind: "file", name: "Chapter one", path: "chapter-one.md", documentId: "doc-1" }}
      isPending={false}
      error={error}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />,
    async () => {
      expect(document.body.textContent).toContain(message);
    },
  );
});
