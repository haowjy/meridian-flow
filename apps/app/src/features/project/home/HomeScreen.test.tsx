// @vitest-environment jsdom
/** Rendered Home interaction contracts spanning cards, movement, and command transport. */

import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/lib/i18n";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { HomeScreen } from "./HomeScreen";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join(""),
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("./NewThreadComposerToolbar", () => ({ NewThreadComposerToolbar: () => null }));
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

const thread = {
  id: "thread-1",
  title: "River",
  work: { id: "work-1", title: "First Work" },
  lastMessagePreview: "Keep climbing.",
  lastActivityAt: "2026-08-13T00:00:00.000Z",
  attention: "none" as const,
  isFavorite: false,
};
const page = {
  featured: {
    continueChat: { ...thread, id: "thread-0", title: "Peak" },
    favoriteChats: [],
  },
  recentChats: { items: [thread], nextCursor: null },
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const rect = (top: number, bottom = top + 40): DOMRect =>
  ({
    top,
    bottom,
    left: 0,
    right: 400,
    width: 400,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON() {},
  }) as DOMRect;

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

describe("HomeScreen", () => {
  it("suppresses inverse favorite movement until the pending favorite command settles", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const patches: Array<{
      body: unknown;
      resolve: (value: Response) => void;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/home-feed")) return Promise.resolve(response(page));
        let resolve!: (value: Response) => void;
        const pending = new Promise<Response>((done) => {
          resolve = done;
        });
        patches.push({ body: JSON.parse(String(init?.body)), resolve });
        return pending;
      }),
    );

    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <HomeScreen projectId="project-1" onSelectThread={vi.fn()} onOpenThread={vi.fn()} />
        </QueryClientProvider>
      </I18nProvider>,
      async () => {
        await waitFor(() =>
          Boolean(document.querySelector('[aria-label="Add River to favorites"]')),
        );
        vi.spyOn(window.HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(20));
        const scroll = document.querySelector(".app-scroll") as HTMLElement;
        Object.defineProperties(scroll, {
          scrollTop: { value: 100, writable: true },
          scrollHeight: { value: 1_000 },
          clientHeight: { value: 300 },
        });
        scroll.getBoundingClientRect = () => rect(0, 300);

        const add = document.querySelector(
          '[aria-label="Add River to favorites"]',
        ) as HTMLButtonElement;
        add.focus();
        await act(async () => add.click());

        await waitFor(() =>
          Boolean(document.querySelector('[aria-label="Remove River from favorites"]')),
        );
        const remove = document.querySelector(
          '[aria-label="Remove River from favorites"]',
        ) as HTMLButtonElement;
        expect(document.activeElement).toBe(remove);
        expect(remove.getAttribute("aria-disabled")).toBe("true");
        const settledScrollTop = scroll.scrollTop;

        await act(async () => remove.click());
        expect(patches.map(({ body }) => body)).toEqual([{ isFavorite: true }]);
        expect(document.activeElement).toBe(remove);
        expect(remove.getAttribute("aria-disabled")).toBe("true");
        expect(scroll.scrollTop).toBe(settledScrollTop);

        patches[0]?.resolve(
          response({
            threadId: "thread-1",
            isFavorite: true,
            manuallyUnread: false,
            lastOpenedAt: null,
            attention: "none",
          }),
        );
        await waitFor(() => remove.getAttribute("aria-disabled") === null);

        expect(patches.map(({ body }) => body)).toEqual([{ isFavorite: true }]);
        expect(document.activeElement).toBe(remove);
        expect(scroll.scrollTop).toBe(settledScrollTop);
      },
      { drainMacrotask: true },
    );
  });
});
