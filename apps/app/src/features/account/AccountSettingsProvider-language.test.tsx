// @vitest-environment jsdom
/** Query language seeds the page; an explicit writer choice takes over without rollback. */
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { readAccountSettingsCache } from "@/lib/account-settings-cache";
import { changeLocale } from "@/lib/i18n";
import { AccountSettingsProvider, useSharedAccountSettings } from "./AccountSettingsProvider";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ update: vi.fn(), epoch: new AbortController(), hints: {} }));
vi.mock("@/client/api/account-api", () => ({
  updateAccountSettings: mocks.update,
  getAccountSettings: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => "locale-test-account",
  useAccountEpochSignal: () => mocks.epoch.signal,
}));
vi.mock("@/client/providers/ConnectivityProvider", () => ({
  useConnectivityHints: () => mocks.hints,
}));
vi.mock("@/client/working-set", () => ({
  bindWorkingSetSyncLifetime: () => () => {},
  configureWorkingSetSync: () => {},
}));
function Probe() {
  const preference = useSharedAccountSettings().preference("language");
  return (
    <>
      <button type="button" onClick={() => preference.change("en")}>
        English
      </button>
      <span role="status">{preference.error ? "Not saved" : ""}</span>
    </>
  );
}
it("keeps the explicit language choice visible after a failed save, even with a query override", async () => {
  localStorage.clear();
  window.history.replaceState(null, "", "?locale=zh");
  mocks.update.mockRejectedValue(new HttpResponseError("rejected", 400, {}));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const query = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={query}>
          <AccountSettingsProvider
            serverValue={{ ...DEFAULT_ACCOUNT_APPEARANCE, workingSetSyncEnabled: true }}
          >
            <Probe />
          </AccountSettingsProvider>
        </QueryClientProvider>,
      ),
    );
    expect(document.documentElement.lang).toBe("zh");
    expect(readAccountSettingsCache("locale-test-account")?.language).toBe("en");
    await act(async () => host.querySelector("button")?.click());
    for (
      let attempt = 0;
      attempt < 30 && host.querySelector('[role="status"]')?.textContent !== "Not saved";
      attempt++
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Not saved");
    expect(document.documentElement.lang).toBe("en");
    expect(new URLSearchParams(window.location.search).get("locale")).toBe("zh");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    query.clear();
    localStorage.clear();
    window.history.replaceState(null, "", window.location.pathname);
    changeLocale("en");
  }
});
