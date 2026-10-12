// @vitest-environment jsdom
/** Preview races cannot change the options sent to a native download. */
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ExportProjectDialog } from "./ExportProjectDialog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("debounces preview options, hides stale counts and downloads directly before closing", async () => {
  const i18n = setupI18n({ locale: "en", messages: {} });
  const replies: ((response: Response) => void)[] = [];
  const fetch = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => replies.push(resolve)),
  );
  vi.stubGlobal("fetch", fetch);
  const close = vi.fn();
  const downloads: string[] = [];
  await withReactRoot(
    <I18nProvider i18n={i18n}>
      <ExportProjectDialog
        accountSignal={new AbortController().signal}
        projectId="project"
        project="Ashfall"
        onClose={close}
      />
    </I18nProvider>,
    async () => {
      vi.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push(this.href);
      });
      const wait = async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        });
      };
      await wait();
      expect(fetch.mock.calls[0]?.[0]).toBe(
        "/api/projects/project/export/preview?scratch=0&uploads=0",
      );
      await act(async () => {
        replies[0]!(
          Response.json({
            outsideLinks: { count: 2, byArea: { scratch: 1, uploads: 1, user: 0, deleted: 0 } },
            pendingDrafts: 3,
          }),
        );
      });
      expect(document.body.textContent).toContain(
        "2 links point to Scratch or Uploads, which won't be included.",
      );
      expect(document.body.textContent).toContain(
        "3 drafts the AI hasn't applied won't be included.",
      );
      const switches = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
      await act(async () => {
        switches[0]!.click();
        switches[1]!.click();
      });
      expect(document.body.textContent).not.toContain("2 links point");
      await wait();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]?.[0]).toBe(
        "/api/projects/project/export/preview?scratch=1&uploads=1",
      );
      await act(async () => {
        replies[1]!(
          Response.json({
            outsideLinks: { count: 0, byArea: { scratch: 0, uploads: 0, user: 0, deleted: 0 } },
            pendingDrafts: 0,
          }),
        );
      });
      expect(document.querySelector('[role="status"]')?.textContent).toBe("");
      const button = [...document.querySelectorAll("button")].find(
        (node) => node.textContent === "Export",
      );
      await act(async () => button!.click());
      expect(downloads).toEqual([
        "https://app.meridian.test/api/projects/project/export.zip?scratch=1&uploads=1",
      ]);
      expect(close).toHaveBeenCalledOnce();
    },
    { drainMacrotask: true },
  );
});
it("ignores a late preview from a retired account and cannot download for it", async () => {
  const account = new AbortController();
  const i18n = setupI18n({ locale: "en", messages: {} });
  let reply: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      }),
  );
  await withReactRoot(
    <I18nProvider i18n={i18n}>
      <ExportProjectDialog
        accountSignal={account.signal}
        projectId="project"
        project="Ashfall"
        onClose={() => {}}
      />
    </I18nProvider>,
    async () => {
      const download = vi
        .spyOn(window.HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {});
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      await act(async () => {
        account.abort();
        reply(
          Response.json({
            outsideLinks: { count: 12, byArea: { scratch: 0, uploads: 0, user: 12, deleted: 0 } },
            pendingDrafts: 3,
          }),
        );
      });
      expect(document.body.textContent).not.toContain("12 links");
      const button = [...document.querySelectorAll("button")].find(
        (node) => node.textContent === "Export",
      );
      await act(async () => button!.click());
      expect(download).not.toHaveBeenCalled();
    },
    { drainMacrotask: true },
  );
});
