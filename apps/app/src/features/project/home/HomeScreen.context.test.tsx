// @vitest-environment jsdom
/** Prospective Work and write-mode readiness at the rendered Home boundary. */
import { I18nProvider } from "@lingui/react";
import type { ListWorksResponse } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { i18n } from "@/lib/i18n";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { HomeScreen } from "./HomeScreen";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join(""),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));

vi.mock("@/client/stores", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/client/stores")>();
  return {
    ...actual,
    useIsProjectPendingCreation: () => false,
    useAnnouncement: () => ({ announce: vi.fn(), announceError: vi.fn() }),
    useThreadActions: () => ({
      ensureThread: vi.fn(),
      appendUserTurn: vi.fn(),
      stageFirstSend: vi.fn(),
      preserveFirstSendRouteDraft: vi.fn(),
      armFirstSend: vi.fn(),
    }),
  };
});
vi.mock("@/components/app/composer/placeholders", () => ({
  useComposerPlaceholder: () => "Write",
}));
vi.mock("./NewThreadComposerToolbar", () => ({
  NewThreadComposerToolbar: ({
    work,
    works,
    selectedWorkId,
    onWorkChange,
    onModePendingChange,
  }: {
    work: Work | null;
    works: Work[];
    selectedWorkId: string | null;
    onWorkChange(work: Work): void;
    onModePendingChange(pending: boolean): void;
  }) => (
    <div data-testid="prospective-context" data-work-id={selectedWorkId ?? ""}>
      <span>{work?.name ?? "Unavailable"}</span>
      <button type="button" onClick={() => works[1] && onWorkChange(works[1])}>
        Choose second Work
      </button>
      <button type="button" onClick={() => onModePendingChange(true)}>
        Begin mode change
      </button>
    </div>
  ),
}));

const work = (id: string, name: string): Work => ({
  id,
  projectId: "project-1",
  createdByUserId: "user-1",
  name,
  slug: name.toLowerCase().replaceAll(" ", "-"),
  description: null,
  goal: null,
  status: "active",
  aiWriteMode: "draft",
  archivedAt: null,
  lastActivityAt: "2026-08-14T00:00:00.000Z",
  deletedAt: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
});
const first = work("work-1", "Book 1");
const second = work("work-2", "Expedition");

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition not reached");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Home prospective context", () => {
  it("keeps a disappeared writer-selected Work explicit and blocks send while mode settles", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const works: ListWorksResponse = { defaultWorkId: first.id, works: [first, second] };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const path = String(input);
        if (path.includes("/works")) return Promise.resolve(response(works));
        if (path.includes("/home-feed")) {
          return Promise.resolve(
            response({
              featured: { continueChat: null, favoriteChats: [] },
              recentChats: { items: [], nextCursor: null },
            }),
          );
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <HomeScreen projectId="project-1" onSelectThread={vi.fn()} onOpenThread={vi.fn()} />
        </QueryClientProvider>
      </I18nProvider>,
      async () => {
        await waitFor(() => document.body.textContent?.includes("Book 1") === true);
        const choose = [...document.querySelectorAll("button")].find(
          ({ textContent }) => textContent === "Choose second Work",
        ) as HTMLButtonElement;
        await act(async () => choose.click());
        expect(
          document.querySelector('[data-testid="prospective-context"]')?.textContent,
        ).toContain("Expedition");

        await act(async () => {
          client.setQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"), {
            defaultWorkId: first.id,
            works: [first],
          });
        });
        await waitFor(
          () =>
            document
              .querySelector('[data-testid="prospective-context"]')
              ?.textContent?.includes("Unavailable") === true,
        );
        const context = document.querySelector('[data-testid="prospective-context"]');
        expect(context?.getAttribute("data-work-id")).toBe(second.id);
        expect(context?.textContent).toContain("Unavailable");
        expect(context?.textContent).toContain("Choose second Work");

        await act(async () => {
          client.setQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"), works);
        });
        const textarea = document.querySelector(
          'textarea[aria-label="Message"]',
        ) as HTMLTextAreaElement;
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          setter?.call(textarea, "Opening line");
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          (
            [...document.querySelectorAll("button")].find(
              ({ textContent }) => textContent === "Begin mode change",
            ) as HTMLButtonElement
          ).click();
        });
        const send = document.querySelector(
          'button[aria-label="Send message"]',
        ) as HTMLButtonElement;
        expect(send.disabled).toBe(true);
        expect(
          document.getElementById(send.getAttribute("aria-describedby") ?? "")?.textContent,
        ).toBe("Finishing write mode change");
      },
      { drainMacrotask: true },
    );
  });
});
