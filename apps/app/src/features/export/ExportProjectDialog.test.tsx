// @vitest-environment jsdom
/** The start handoff shows honest preparation/failure, then counts without buffering a ZIP. */
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ExportProjectDialog } from "./ExportProjectDialog";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});
it("retries a failed start and follows its download only after the counted response", async () => {
  const i18n = setupI18n({ locale: "en", messages: {} });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  notifyManager.setScheduler(queueMicrotask);
  let answer: (response: Response) => void = () => {
    throw new Error("No request in flight");
  };
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  await withReactRoot(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ExportProjectDialog
          accountSignal={new AbortController().signal}
          projectId="project"
          project="Ashfall"
          onClose={() => {}}
        />
      </QueryClientProvider>
    </I18nProvider>,
    async () => {
      const click = async (label: string) => {
        const button = [...document.querySelectorAll("button")].find(
          (button) => button.textContent === label,
        );
        if (!button) throw new Error(`Missing ${label}`);
        await act(async () => button.click());
      };
      const downloads: string[] = [];
      vi.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push(this.href);
      });
      const switches = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
      expect(switches).toHaveLength(2);
      expect(switches.map((input) => input.getAttribute("aria-checked"))).toEqual([
        "false",
        "false",
      ]);
      await click("Export");
      expect(document.body.textContent).toContain("Preparing…");
      expect(switches.every((input) => input.disabled)).toBe(true);
      expect(downloads).toEqual([]);
      await act(async () => {
        answer(new Response('{"message":"unavailable"}', { status: 503 }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain("Couldn't start the export.");
      expect(switches.every((input) => !input.disabled)).toBe(true);
      await click("Retry");
      await act(async () => {
        answer(
          Response.json({
            downloadUrl: "/api/projects/project/export.zip?export=ticket",
            fileName: "Ashfall.zip",
            outsideLinks: { count: 12, areas: ["uploads", "scratch"] },
            pendingDrafts: 3,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(downloads).toEqual([
        "https://app.meridian.test/api/projects/project/export.zip?export=ticket",
      ]);
      expect(document.body.textContent).toContain(
        "12 links point to Scratch or Uploads, which aren't included.",
      );
      expect(document.body.textContent).toContain(
        "3 drafts the AI hasn't applied aren't included.",
      );
      expect(document.querySelector('[role="status"]')).not.toBeNull();
      expect(document.querySelector('[role="switch"]')).toBeNull();
      expect(fetch.mock.calls[0]).toEqual([
        "/api/projects/project/exports",
        expect.objectContaining({ body: '{"scratch":false,"uploads":false}' }),
      ]);
    },
    { drainMacrotask: true },
  );
  client.clear();
});

it("does not download or show a late response from a retired account epoch", async () => {
  const account = new AbortController();
  const i18n = setupI18n({ locale: "en", messages: {} });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  notifyManager.setScheduler(queueMicrotask);
  let answer: (response: Response) => void = () => {
    throw new Error("No request in flight");
  };
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );
  await withReactRoot(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <ExportProjectDialog
          accountSignal={account.signal}
          projectId="project"
          project="Ashfall"
          onClose={() => {}}
        />
      </QueryClientProvider>
    </I18nProvider>,
    async () => {
      const downloads: string[] = [];
      vi.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push(this.href);
      });
      const button = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Export",
      );
      if (!button) throw new Error("Export button missing");
      await act(async () => button.click());
      await act(async () => {
        account.abort();
        answer(
          Response.json({
            downloadUrl: "/retired-export",
            fileName: "Private.zip",
            outsideLinks: { count: 1, areas: ["user"] },
            pendingDrafts: 3,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(downloads).toEqual([]);
      expect(document.body.textContent).not.toContain("Private.zip");
      expect(document.body.textContent).not.toContain("Your browser is downloading");
    },
    { drainMacrotask: true },
  );
  client.clear();
});
