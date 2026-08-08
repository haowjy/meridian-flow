import type { Work } from "@meridian/contracts/protocol";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/meridian-error";
import { withReactRoot } from "@/test-support/react-dom-harness";

const { mutateAsync, announce, announceError } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  announce: vi.fn(),
  announceError: vi.fn(),
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
vi.mock("@/client/query/useRebindThreadWork", () => ({
  useRebindThreadWork: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/client/stores", () => ({ useAnnouncement: () => ({ announce, announceError }) }));
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => false }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { ThreadWorkControl } = await import("./ThreadWorkControl");

describe("ThreadWorkControl", () => {
  beforeEach(() => vi.clearAllMocks());
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
});
