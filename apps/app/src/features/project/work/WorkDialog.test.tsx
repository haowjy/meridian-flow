// @vitest-environment jsdom
import type { Work } from "@meridian/contracts/works";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { WorkDialog } from "./WorkDialog";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/client/query/useWorks", () => ({ useWorks: vi.fn(), useWorkMutations: vi.fn() }));

describe("WorkDialog lifecycle admission", () => {
  it("admits one action synchronously and exposes coarse-pointer targets", async () => {
    const action = vi.fn();
    function Harness() {
      const [pending, setPending] = useState(false);
      return (
        <WorkDialog
          work={fixture()}
          pending={pending}
          error={null}
          onClose={() => undefined}
          onAction={(value) => {
            action(value);
            setPending(true);
          }}
        />
      );
    }
    await withReactRoot(<Harness />, () => {
      const archive = button("Archive Work");
      const remove = button("Delete Work");
      act(() => {
        archive.click();
        remove.click();
      });
      expect(action).toHaveBeenCalledOnce();
      expect(action).toHaveBeenCalledWith({ type: "archive", workId: fixture().id });
      expect(button("Archive Work").disabled).toBe(true);
      expect(button("Delete Work").disabled).toBe(true);
      expect(button("Cancel").disabled).toBe(true);
      act(() => button("Cancel").click());
      expect(document.body.textContent).toContain("Manage Work");
      expect(button("Archive Work").className).toContain("pointer:coarse");
    });
  });
});
function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  if (!(node instanceof window.HTMLButtonElement)) throw new Error(`missing ${label}`);
  return node;
}
function fixture(): Work {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Work A",
    slug: "work-a",
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    aiWriteMode: "draft",
    unpushedChangeCount: 0,
    lastActivityAt: "2026-08-15T00:00:00.000Z",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}
