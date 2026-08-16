// @vitest-environment jsdom
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
const queryHooks = await import("@/client/query/useWorks");
const { WorkDialog, WorkScreen, workFormAction } = await import("./WorkScreen");

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
      await settleDialog();
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
      await settleDialog();
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
      await settleDialog();
      expect(input("work-name").value).toBe("");
      expect(input("work-goal").value).toBe("");
      expect(input("work-description").value).toBe("");
    });
  });
});

describe("WorkScreen actions", () => {
  it("names active and archived sections and keeps archived controls out of focus order until expanded", async () => {
    mockManagerWorks([
      workFixture("active-a", "Active A", "Goal A"),
      archivedWorkFixture("archived-a", "Archived A"),
    ]);

    await withReactRoot(<WorkScreen projectId="project-1" />, async () => {
      expect(sectionNamed("Active Work")).not.toBeNull();
      const archivedSection = sectionNamed("Archived Work");
      const disclosure = buttonContaining("Archived Work");
      expect(document.querySelectorAll("h2")).toHaveLength(2);
      expect(buttonContaining("New Work").className).toContain("[@media(pointer:coarse)]:min-h-11");
      expect(
        document.querySelector<HTMLButtonElement>('[aria-label="Edit Active A"]')?.className,
      ).toContain("[@media(pointer:coarse)]:size-11");
      expect(archivedSection).not.toBeNull();
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure.hasAttribute("aria-controls")).toBe(false);
      expect(document.body.textContent).not.toContain("Archived A");
      expect(focusableLabels()).toEqual(["NewWork", "EditActiveA", "ArchivedWork(1)"]);

      await act(async () => disclosure.click());
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      const panelId = disclosure.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId ?? "")).not.toBeNull();
      expect(document.body.textContent).toContain("Archived A");
      expect(focusableLabels().slice(-1)).toEqual(["EditArchivedA"]);

      await act(async () => disclosure.click());
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure.hasAttribute("aria-controls")).toBe(false);
      expect(document.getElementById(panelId ?? "")).toBeNull();
      expect(document.body.textContent).not.toContain("Archived A");
    });
  });

  it("omits Archived Work when there are no archived records", async () => {
    mockManagerWorks([workFixture("active-a", "Active A", "Goal A")]);
    await withReactRoot(<WorkScreen projectId="project-1" />, () => {
      expect(sectionNamed("Active Work")).not.toBeNull();
      expect(sectionNamed("Archived Work")).toBeNull();
    });
  });

  it("keeps the Active Work empty state and New Work action beside archived records", async () => {
    mockManagerWorks([archivedWorkFixture("archived-a", "Archived A")]);
    await withReactRoot(<WorkScreen projectId="project-1" />, () => {
      expect(sectionNamed("Active Work")?.textContent).toContain("No active Work yet.");
      expect(buttonContaining("New Work")).not.toBeNull();
      expect(buttonContaining("Archived Work").getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("uses the shared container grid and restores cancelled creation focus to New Work", async () => {
    mockManagerWorks([workFixture("active-a", "Active A", "Goal A")]);
    vi.mocked(queryHooks.useWorkMutations).mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof queryHooks.useWorkMutations>);

    await withReactRoot(<WorkScreen projectId="project-1" />, async () => {
      expect(document.querySelector(".project-screen-column")).not.toBeNull();
      expect(document.querySelector("ul")?.className).toContain("@2xl/project-home:grid-cols-2");
      const newWork = buttonContaining("New Work");
      const focus = vi.spyOn(window.HTMLElement.prototype, "focus").mockImplementation(() => {});
      await act(async () => newWork.click());
      await settleDialog();
      expect(buttonContaining("Cancel").className).toContain("[@media(pointer:coarse)]:min-h-11");
      expect(buttonContaining("Save Work").className).toContain(
        "[@media(pointer:coarse)]:min-h-11",
      );
      expect(document.querySelector('[data-slot="dialog-content"]')?.className).toContain(
        "[@media(pointer:coarse)]:[&>button:last-child]:size-11",
      );
      await act(async () => clickButton("Cancel"));
      await Promise.resolve();
      expect(focus).toHaveBeenCalledWith();
      expect(focus.mock.instances.at(-1)).toBe(newWork);
      focus.mockRestore();
    });
  });

  it("restores cancelled creation focus while Work is still loading", async () => {
    vi.mocked(queryHooks.useWorks).mockReturnValue({
      works: null,
      newChatFallbackWorkId: null,
      isError: false,
      isFetching: true,
      status: "loading",
      refetch: vi.fn(),
    });
    vi.mocked(queryHooks.useWorkMutations).mockReturnValue({
      mutate: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof queryHooks.useWorkMutations>);

    await withReactRoot(<WorkScreen projectId="project-1" />, async () => {
      const newWork = buttonContaining("New Work");
      await act(async () => newWork.click());
      await settleDialog();
      await act(async () => clickButton("Cancel"));
      expect(document.activeElement).toBe(newWork);
    });
  });

  it.each([
    ["create", "New Work", "Save Work", "new"],
    ["update", "Edit Active A", "Save Work", "edit:active-a"],
    ["archive", "Edit Active A", "Archive", "archived-disclosure"],
    ["unarchive", "Edit Archived A", "Unarchive", "edit:archived-a"],
    ["delete", "Edit Active A", "Delete", "edit:active-b"],
  ] as const)("restores focus after successful %s through the Radix dialog", async (kind, opener, actionLabel, target) => {
    let works =
      kind === "unarchive"
        ? [archivedWorkFixture("archived-a", "Archived A")]
        : kind === "delete"
          ? [
              workFixture("active-a", "Active A", "Goal A"),
              archivedWorkFixture("archived-x", "Archived X"),
              workFixture("active-b", "Active B", "Goal B"),
            ]
          : [
              workFixture("active-a", "Active A", "Goal A"),
              workFixture("active-b", "Active B", "Goal B"),
            ];
    let rerender: (() => void) | null = null;
    vi.mocked(queryHooks.useWorks).mockImplementation(() => ({
      works,
      newChatFallbackWorkId: null,
      isError: false,
      isFetching: false,
      status: "ready",
      refetch: vi.fn(),
    }));
    vi.mocked(queryHooks.useWorkMutations).mockReturnValue({
      mutate: (
        action: { type: string; workId?: string },
        options: { onSuccess?: (result: Work | null) => void; onSettled?: () => void },
      ) => {
        let result: Work | null = null;
        if (action.type === "create") {
          result = workFixture("created-a", "Created A", "");
          works = [...works, result];
        } else if (action.type === "archive") {
          works = works.map((work) =>
            work.id === action.workId ? archivedWorkFixture(work.id, work.name) : work,
          );
          result = works.find((work) => work.id === action.workId) ?? null;
        } else if (action.type === "unarchive") {
          works = works.map((work) =>
            work.id === action.workId ? workFixture(work.id, work.name, work.goal ?? "") : work,
          );
          result = works.find((work) => work.id === action.workId) ?? null;
        } else if (action.type === "delete") {
          works = works.filter((work) => work.id !== action.workId);
        } else {
          result = works.find((work) => work.id === action.workId) ?? null;
        }
        options.onSuccess?.(result);
        rerender?.();
        options.onSettled?.();
      },
      reset: vi.fn(),
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof queryHooks.useWorkMutations>);

    function Harness() {
      const [, setVersion] = useState(0);
      rerender = () => setVersion((value) => value + 1);
      return <WorkScreen projectId="project-1" />;
    }

    await withReactRoot(<Harness />, async () => {
      await settleDialog();
      if (kind === "delete" || kind === "unarchive")
        await act(async () => buttonContaining("Archived Work").click());
      const openerButton =
        document.querySelector<HTMLButtonElement>(`button[aria-label="${opener}"]`) ??
        buttonContaining(opener);
      await act(async () => openerButton.click());
      await settleDialog();
      if (kind === "create") {
        await act(async () => {
          const name = input("work-name") as HTMLInputElement;
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
            name,
            "Created A",
          );
          name.dispatchEvent(new window.Event("input", { bubbles: true }));
        });
      }
      await act(async () => clickButton(actionLabel));
      await settleDialog();
      expect(document.activeElement?.getAttribute("data-work-focus")).toBe(target);
      if (kind === "archive")
        expect(buttonContaining("Archived Work").getAttribute("aria-expanded")).toBe("false");
    });
  });
});

async function settleDialog() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mockManagerWorks(works: Work[]) {
  vi.mocked(queryHooks.useWorks).mockImplementation(() => ({
    works,
    newChatFallbackWorkId: null,
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
