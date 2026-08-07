import type { Work } from "@meridian/contracts/works";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: vi.fn(),
  useWorkMutations: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const queryHooks = await import("@/client/query/useWorks");
const { WorkDialog, WorksManager, workFormAction } = await import("./WorksManager");

describe("WorkDialog identity", () => {
  it("remounts controlled values for each Work and allows optional strings to clear", async () => {
    const actions: unknown[] = [];
    let selectWork: ((work: Work | "new") => void) | null = null;

    function Harness() {
      const [work, setWork] = useState<Work | "new">(workFixture("work-a", "Work A", "Goal A"));
      selectWork = setWork;
      return (
        <WorkDialog
          key={work === "new" ? "new" : work.id}
          work={work}
          pending={false}
          error={null}
          onClose={() => undefined}
          onAction={(action) => actions.push(action)}
        />
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(
        workFormAction(workFixture("work-a", "Work A", "Goal A"), {
          name: "Edited A",
          goal: "",
          description: "",
        }),
      ).toEqual({
        type: "update",
        workId: "work-a",
        data: { name: "Edited A", goal: "", description: "" },
      });

      await act(async () => {
        selectWork?.(workFixture("work-b", "Work B", "Goal B"));
      });
      expect(input("work-name").value).toBe("Work B");
      expect(input("work-goal").value).toBe("Goal B");
      clickButton("Save Work");
      expect(actions.at(-1)).toEqual({
        type: "update",
        workId: "work-b",
        data: { name: "Work B", goal: "Goal B", description: "Description Work B" },
      });

      await act(async () => {
        selectWork?.("new");
      });
      expect(input("work-name").value).toBe("");
      expect(input("work-goal").value).toBe("");
      expect(input("work-description").value).toBe("");
    });
  });
});

describe("WorksManager actions", () => {
  it("announces switch failure and synchronously rejects a competing switch", async () => {
    const mutate = vi.fn();
    vi.mocked(queryHooks.useWorks).mockReturnValue({
      works: [workFixture("work-a", "Work A", "Goal A"), workFixture("work-b", "Work B", "Goal B")],
      currentWork: workFixture("work-a", "Work A", "Goal A"),
      currentWorkId: "work-a",
      defaultWorkId: "work-a",
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    vi.mocked(queryHooks.useWorkMutations).mockReturnValue({
      mutate,
      reset: vi.fn(),
      isPending: false,
      error: new Error("Could not switch Work"),
    } as unknown as ReturnType<typeof queryHooks.useWorkMutations>);

    await withReactRoot(<WorksManager projectId="project-1" />, () => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not switch Work",
      );
      buttonContaining("Work A").click();
      buttonContaining("Work B").click();
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledWith(
        { type: "switch", workId: "work-a" },
        expect.objectContaining({ onSettled: expect.any(Function) }),
      );
    });
  });
});

function workFixture(id: string, name: string, goal: string): Work {
  return {
    id,
    projectId: "project-1",
    createdByUserId: "user-1",
    name,
    goal,
    description: `Description ${name}`,
    status: "active",
    archivedAt: null,
    aiWriteMode: "draft",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
  } as Work;
}

function input(id: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.getElementById(id);
  if (
    !(element instanceof window.HTMLInputElement) &&
    !(element instanceof window.HTMLTextAreaElement)
  ) {
    throw new Error(`Missing input ${id}`);
  }
  return element;
}

function clickButton(label: string): void {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof window.HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  button.click();
}

function buttonContaining(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof window.HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return button;
}
