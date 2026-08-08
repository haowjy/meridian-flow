// @vitest-environment jsdom
import type { Work } from "@meridian/contracts/protocol";
import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { withReactRoot } from "@/test-support/react-dom-harness";

const { mutateAsync, announce, announceError, shell } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  announce: vi.fn(),
  announceError: vi.fn(),
  shell: { pending: false },
}));
const active = {
  id: "work-a",
  name: "Jade Path",
  goal: "Reach ascension",
  status: "active",
} as Work;
const archived = { id: "work-b", name: "Old outline", goal: null, status: "archived" } as Work;
const external = { id: "work-c", name: "New projection", goal: null, status: "active" } as Work;
const extraWorks = Array.from({ length: 10 }, (_, index) => ({
  ...active,
  id: `work-extra-${index}`,
  name: `Long catalog ${index}`,
})) as Work[];

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((message, part, index) => `${message}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [active, archived, external, ...extraWorks], refetch: vi.fn() }),
}));
vi.mock("@/client/query/useRebindThreadWork", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/query/useRebindThreadWork")>()),
  useRebindThreadWork: () => ({ mutateAsync, isPending: shell.pending }),
}));
vi.mock("@/client/stores", () => ({ useAnnouncement: () => ({ announce, announceError }) }));
const { ComposerWorkControl } = await import("./ComposerWorkControl");

async function openDesktopPicker() {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Change work for this chat"]',
  );
  await act(async () => trigger?.click());
}

describe("ComposerWorkControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() },
    });
    shell.pending = false;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });
  it("offers searchable Work choices", async () => {
    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        await openDesktopPicker();
        const search = document.querySelector<HTMLInputElement>('input[type="search"]');
        expect(search?.getAttribute("placeholder")).toBe("Search works");
        await act(async () => {
          if (!search) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(search, "ascension");
          search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(document.body.textContent).toContain("Jade Path");
        expect(document.body.textContent).not.toContain("Old outline");
        await act(async () => {
          if (!search) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(search, "missing");
          search.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(document.body.textContent).toContain("No works match your search.");
      },
    );
  });

  it("drills into and back from the same Work list in the overflow surface", async () => {
    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        const overflow = document.querySelector<HTMLButtonElement>(
          'button[aria-label="More composer settings"]',
        );
        await act(async () => overflow?.click());
        const workEntry = [
          ...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'),
        ].find((button) => button.textContent === "Work: Jade Path");
        await act(async () => workEntry?.click());
        const search = document.querySelector<HTMLInputElement>('input[type="search"]');
        expect(document.activeElement).toBe(search);
        const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
        search?.dispatchEvent(home);
        expect(document.activeElement).toBe(search);
        expect(home.defaultPrevented).toBe(false);
        const rows = [...document.querySelectorAll<HTMLButtonElement>("section button")];
        rows[0]?.focus();
        await act(async () =>
          rows[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
        );
        expect(document.activeElement).toBe(rows[0]);
        expect(document.querySelectorAll('input[type="search"]')).toHaveLength(1);
        expect(document.body.textContent).toContain("Old outline, Archived");
        const back = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Back"),
        );
        await act(async () => back?.click());
        expect(document.querySelector('input[type="search"]')).toBeNull();
        expect(document.body.textContent).toContain("Work: Jade Path");
        expect(document.activeElement).toBe(
          [
            ...document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'),
          ].find((button) => button.textContent === "Work: Jade Path"),
        );
      },
    );
  });

  it("labels current and archived Works and commits a choice immediately", async () => {
    mutateAsync.mockResolvedValue({
      changed: true,
      preferenceChanged: false,
      work: archived,
      receipt: { inverse: { command: "switch", workId: active.id } },
    });
    let project!: (work: Work) => void;
    function Harness() {
      const [work, setWork] = useState(active);
      project = setWork;
      return <ComposerWorkControl projectId="project-1" threadId="thread-1" work={work} />;
    }
    await withReactRoot(<Harness />, async () => {
      const trigger = document.querySelector(
        'button[aria-label="Change work for this chat, currently Jade Path"]',
      );
      expect(trigger).not.toBeNull();
      await openDesktopPicker();
      expect(document.body.textContent).toContain("Current for this chat");
      expect(document.body.textContent).toContain("Old outline, Archived");
      const archivedButton = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Old outline"),
      );
      await act(async () => archivedButton?.click());
      await act(async () => project(archived));
      expect(mutateAsync).toHaveBeenCalledWith("work-b");
      expect(document.body.textContent).toContain("Undo");
    });
  });

  it("renders one structured refusal associated only with its target row", async () => {
    mutateAsync.mockRejectedValue(
      new MeridianApiError({
        code: "thread_busy",
        message: "Busy",
        retryable: true,
        source: "system",
      }),
    );
    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        await openDesktopPicker();
        const archivedButton = [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Old outline"),
        );
        await act(async () => archivedButton?.click());

        const alerts = document.querySelectorAll('[role="alert"]');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.textContent).toContain("Wait for this response to finish");
        expect(archivedButton?.getAttribute("aria-describedby")).toBe(alerts[0]?.id);
        expect(announceError).toHaveBeenCalledOnce();
      },
    );
  });

  it("returns focus and clears errors after ambiguity confirms the commit", async () => {
    const { ThreadWorkReconciliationError } = await import("@/client/query/useRebindThreadWork");
    mutateAsync.mockRejectedValue(new ThreadWorkReconciliationError(new TypeError("lost"), true));

    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        const trigger = document.querySelector(
          'button[aria-label="Change work for this chat, currently Jade Path"]',
        ) as HTMLButtonElement;
        await openDesktopPicker();
        const archivedButton = [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Old outline"),
        );
        await act(async () => archivedButton?.click());
        expect(document.activeElement).toBe(trigger);
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
      },
    );
  });

  it("keeps a truthful retry alert when ambiguity reconciles without a commit", async () => {
    const { ThreadWorkReconciliationError } = await import("@/client/query/useRebindThreadWork");
    mutateAsync.mockRejectedValue(new ThreadWorkReconciliationError(new TypeError("lost"), false));
    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        await openDesktopPicker();
        const archivedButton = [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Old outline"),
        );
        const focus = vi
          .spyOn(archivedButton as HTMLButtonElement, "focus")
          .mockImplementation(() => {});
        await act(async () => archivedButton?.click());
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
        expect(document.body.textContent).toContain("The Work did not change. Try again.");
        expect(archivedButton?.disabled).toBe(false);
        expect(focus).toHaveBeenCalledOnce();
      },
    );
  });

  it("distinguishes a missing current binding from an unavailable target", async () => {
    mutateAsync.mockRejectedValue(
      new MeridianApiError({
        code: "thread_work_missing",
        message: "Missing primary",
        retryable: false,
        source: "system",
      }),
    );
    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        await openDesktopPicker();
        const archivedButton = [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Old outline"),
        );
        await act(async () => archivedButton?.click());
        expect(document.body.textContent).toContain("This chat's current Work could not be found");
        expect(document.body.textContent).not.toContain("no longer available");
      },
    );
  });

  it("disables every retry while an ambiguous outcome is reconciling", async () => {
    let finish!: () => void;
    mutateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          shell.pending = true;
          finish = () => {
            shell.pending = false;
            resolve({ changed: false });
          };
        }),
    );
    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        const overflow = document.querySelector<HTMLButtonElement>(
          'button[aria-label="More composer settings"]',
        );
        await act(async () => overflow?.click());
        const workEntry = document.querySelector<HTMLButtonElement>(
          '[data-slot="popover-content"] button',
        );
        expect(workEntry?.textContent).toBe("Work: Jade Path");
        await act(async () => workEntry?.click());
        const archivedButton = [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Old outline"),
        );
        await act(async () => archivedButton?.click());
        const choiceButtons = [...document.querySelectorAll<HTMLButtonElement>("section button")];
        expect(choiceButtons.every((button) => button.disabled)).toBe(true);
        expect(archivedButton?.textContent).toContain("Changing work");
        const back = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Back"),
        );
        expect(back?.disabled).toBe(true);
        expect(
          document.querySelector('[data-slot="popover-content"]')?.getAttribute("aria-busy"),
        ).toBe("true");
        expect(
          document
            .querySelector('button[aria-label="More composer settings"]')
            ?.getAttribute("aria-busy"),
        ).toBe("true");
        await act(async () => finish());
      },
    );
  });

  it("clears direct Undo when an external Work projection supersedes a local commit", async () => {
    mutateAsync.mockResolvedValue({
      changed: true,
      preferenceChanged: false,
      work: archived,
      receipt: { inverse: { command: "switch", workId: active.id } },
    });
    let project!: (work: Work) => void;
    function Harness() {
      const [work, setWork] = useState(active);
      project = setWork;
      return <ComposerWorkControl projectId="project-1" threadId="thread-1" work={work} />;
    }
    await withReactRoot(<Harness />, async () => {
      await openDesktopPicker();
      const archivedButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.includes("Old outline"),
      );
      await act(async () => archivedButton?.click());
      await act(async () => project(archived));
      expect(
        [...document.querySelectorAll("button")].some((button) => button.textContent === "Undo"),
      ).toBe(true);
      await act(async () => project(external));
      expect(
        [...document.querySelectorAll("button")].some((button) => button.textContent === "Undo"),
      ).toBe(false);
    });
  });

  it("keeps long Work results in the production scroll region", async () => {
    await withReactRoot(
      <ComposerWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        await openDesktopPicker();
        const results = document.querySelector(".app-scroll.overflow-y-auto");
        expect(results).not.toBeNull();
        expect(results?.querySelectorAll("section button")).toHaveLength(13);
        expect(
          document.querySelector('[class*="radix-popover-content-available-height"]'),
        ).not.toBeNull();
      },
    );
  });
});
