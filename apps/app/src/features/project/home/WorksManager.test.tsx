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
      status: "ready",
      refetch: vi.fn(),
    });
    vi.mocked(queryHooks.useWorkMutations).mockReturnValue({
      mutate,
      reset: vi.fn(),
      isPending: false,
      error: new Error("Could not switch Work"),
    } as unknown as ReturnType<typeof queryHooks.useWorkMutations>);

    await withReactRoot(<WorksManager projectId="project-1" />, () => {
      expect(document.querySelector("h2")?.textContent).toBe("Work");
      expect(buttonContaining("Work A").getAttribute("aria-pressed")).toBe("true");
      expect(buttonContaining("Work B").getAttribute("aria-pressed")).toBe("false");
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

  it("names active and archived sections and keeps archived controls out of focus order until expanded", async () => {
    mockManagerWorks([
      workFixture("active-a", "Active A", "Goal A"),
      archivedWorkFixture("archived-a", "Archived A"),
    ]);

    await withReactRoot(<WorksManager projectId="project-1" />, async () => {
      expect(sectionNamed("Active Work")).not.toBeNull();
      const archivedSection = sectionNamed("Archived Work");
      const disclosure = buttonContaining("Archived Work");
      expect(archivedSection).not.toBeNull();
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure.getAttribute("aria-controls")).toBeTruthy();
      expect(document.body.textContent).not.toContain("Archived A");
      expect(focusableLabels()).toEqual([
        "NewWork",
        "ActiveAGoalAActive",
        "EditActiveA",
        "ArchivedWork(1)",
      ]);

      await act(async () => disclosure.click());
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      expect(document.body.textContent).toContain("Archived A");
      expect(focusableLabels().slice(-2)).toEqual([
        "ArchivedAGoalArchivedAArchived",
        "EditArchivedA",
      ]);
    });
  });

  it("opens and reopens Archived Work when the current Work becomes archived", async () => {
    const active = workFixture("active-a", "Active A", "Goal A");
    const archived = archivedWorkFixture("archived-a", "Archived A");
    let currentWorkId = active.id;
    let rerender: (() => void) | null = null;
    mockManagerWorks([active, archived], () => currentWorkId);

    function Harness() {
      const [, setVersion] = useState(0);
      rerender = () => setVersion((value) => value + 1);
      return <WorksManager projectId="project-1" />;
    }

    await withReactRoot(<Harness />, async () => {
      expect(buttonContaining("Archived Work").getAttribute("aria-expanded")).toBe("false");
      currentWorkId = archived.id;
      await act(async () => rerender?.());
      expect(buttonContaining("Archived Work").getAttribute("aria-expanded")).toBe("true");
      expect(buttonContaining("Archived A").getAttribute("aria-pressed")).toBe("true");

      await act(async () => buttonContaining("Archived Work").click());
      currentWorkId = active.id;
      await act(async () => rerender?.());
      currentWorkId = archived.id;
      await act(async () => rerender?.());
      expect(buttonContaining("Archived Work").getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("opens Archived Work on load when it contains the current Work", async () => {
    const archived = archivedWorkFixture("archived-a", "Archived A");
    mockManagerWorks([archived], () => archived.id);

    await withReactRoot(<WorksManager projectId="project-1" />, () => {
      expect(buttonContaining("Archived Work").getAttribute("aria-expanded")).toBe("true");
      expect(buttonContaining("Archived A").getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("omits Archived Work when there are no archived records", async () => {
    mockManagerWorks([workFixture("active-a", "Active A", "Goal A")]);
    await withReactRoot(<WorksManager projectId="project-1" />, () => {
      expect(sectionNamed("Active Work")).not.toBeNull();
      expect(sectionNamed("Archived Work")).toBeNull();
    });
  });

  it("keeps the Active Work empty state and New Work action beside archived records", async () => {
    mockManagerWorks([archivedWorkFixture("archived-a", "Archived A")], () => null);
    await withReactRoot(<WorksManager projectId="project-1" />, () => {
      expect(sectionNamed("Active Work")?.textContent).toContain("No active Work yet.");
      expect(buttonContaining("New Work")).not.toBeNull();
      expect(buttonContaining("Archived Work").getAttribute("aria-expanded")).toBe("false");
    });
  });
});

function mockManagerWorks(
  works: Work[],
  currentId: () => string | null = () => works[0]?.id ?? null,
) {
  vi.mocked(queryHooks.useWorks).mockImplementation(() => ({
    works,
    currentWork: works.find((work) => work.id === currentId()) ?? null,
    currentWorkId: currentId(),
    defaultWorkId: works[0]?.id ?? null,
    isError: false,
    isFetching: false,
    status: "ready",
    refetch: vi.fn(),
  }));
  vi.mocked(queryHooks.useWorkMutations).mockReturnValue({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  } as unknown as ReturnType<typeof queryHooks.useWorkMutations>);
}

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

function archivedWorkFixture(id: string, name: string): Work {
  return {
    ...workFixture(id, name, `Goal ${name}`),
    status: "archived",
    archivedAt: "2026-08-10T00:00:00.000Z",
  };
}

function sectionNamed(label: string): HTMLElement | null {
  const heading = [...document.querySelectorAll("h2, h3")].find(
    (candidate) => candidate.textContent?.replace(/\s*\(\d+\)$/, "").trim() === label,
  );
  return heading?.closest("section") ?? null;
}

function focusableLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button:not([disabled])")].map((button) =>
    (button.getAttribute("aria-label") ?? button.textContent ?? "").replace(/\s+/g, "").trim(),
  );
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
