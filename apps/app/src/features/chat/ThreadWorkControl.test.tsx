// @vitest-environment jsdom
import type { Work } from "@meridian/contracts/protocol";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { withReactRoot } from "@/test-support/react-dom-harness";

const { mutateAsync, announce, announceError, shell } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  announce: vi.fn(),
  announceError: vi.fn(),
  shell: { phone: false, pending: false },
}));
const active = {
  id: "work-a",
  name: "Jade Path",
  goal: "Reach ascension",
  status: "active",
} as Work;
const archived = { id: "work-b", name: "Old outline", goal: null, status: "archived" } as Work;

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((message, part, index) => `${message}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [active, archived], refetch: vi.fn() }),
}));
vi.mock("@/client/query/useRebindThreadWork", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/query/useRebindThreadWork")>()),
  useRebindThreadWork: () => ({ mutateAsync, isPending: shell.pending }),
}));
vi.mock("@/client/stores", () => ({ useAnnouncement: () => ({ announce, announceError }) }));
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => shell.phone }));
const { ThreadWorkControl } = await import("./ThreadWorkControl");

async function openDesktopPicker() {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Change work for this chat"]',
  );
  await act(async () => trigger?.click());
}

describe("ThreadWorkControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() },
    });
    shell.phone = false;
    shell.pending = false;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
  });
  it("labels current and archived Works and commits a choice immediately", async () => {
    mutateAsync.mockResolvedValue({
      changed: true,
      preferenceChanged: false,
      work: archived,
      receipt: { inverse: { command: "switch", workId: active.id } },
    });
    await withReactRoot(
      <ThreadWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
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
        expect(mutateAsync).toHaveBeenCalledWith("work-b");
        expect(document.body.textContent).toContain("Undo");
      },
    );
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
      <ThreadWorkControl projectId="project-1" threadId="thread-1" work={active} />,
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
      <ThreadWorkControl projectId="project-1" threadId="thread-1" work={active} />,
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
      <ThreadWorkControl projectId="project-1" threadId="thread-1" work={active} />,
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
      <ThreadWorkControl projectId="project-1" threadId="thread-1" work={active} />,
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
      <ThreadWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        await openDesktopPicker();
        const archivedButton = [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Old outline"),
        );
        await act(async () => archivedButton?.click());
        const choiceButtons = [...document.querySelectorAll<HTMLButtonElement>("section button")];
        expect(choiceButtons.every((button) => button.disabled)).toBe(true);
        expect(archivedButton?.textContent).toContain("Changing work");
        await act(async () => finish());
      },
    );
  });

  it("renders the phone picker through the real Sheet control contract", async () => {
    shell.phone = true;
    await withReactRoot(
      <ThreadWorkControl projectId="project-1" threadId="thread-1" work={active} />,
      async () => {
        const trigger = document.querySelector(
          'button[aria-label="Change work for this chat, currently Jade Path"]',
        ) as HTMLButtonElement;
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(trigger.getAttribute("aria-controls")).toBe(dialog?.id);
        expect(dialog?.getAttribute("aria-modal")).toBe("true");
        expect(
          document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")?.textContent,
        ).toContain("Change work for this chat");
        expect(dialog?.className).toContain("w-full");
        expect(dialog?.className).toContain("safe-area-inset-bottom");
        const close = dialog?.querySelector<HTMLButtonElement>("button.absolute");
        expect(close?.className).toContain("size-11");
      },
    );
  });
});
