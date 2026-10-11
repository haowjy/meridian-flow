// @vitest-environment jsdom
/** Account-owned recovery subscriptions preserve working-set write lineage. */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hydrateWorkingSet, replaceRecentRoutes } from "@/client/working-set/driver";
import { buildWorkingSetRoute } from "@/client/working-set/store";
import type { ConnectivityHint, ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { AccountSettingsProvider } from "./AccountSettingsProvider";

const account = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  stop: vi.fn(),
  listener: null as null | ((hint: ConnectivityHint) => void),
  epoch: new AbortController(),
  id: 0,
}));
vi.mock("@/client/api/projects-api", () => ({
  getProjectWorkingSet: account.get,
  updateProjectWorkingSet: account.put,
}));
vi.mock("@/client/providers/ConnectivityProvider", () => ({ useConnectivityHints: () => hints }));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => `account-${account.id}`,
  useAccountEpochSignal: () => account.epoch.signal,
}));
vi.mock("./useAccountSettings", () => ({
  useAccountSettings: () => ({
    value: { theme: "ink-jade", language: "en", statsForNerds: false },
    preference: () => ({ confirmed: true }),
  }),
}));
const hints: ConnectivityHintsPort = {
  subscribe: (_source, listener) => {
    account.listener = listener;
    return account.stop;
  },
  reportConnected: () => {},
  reportDisconnected: () => {},
};
let root: Root | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  account.id += 1;
  account.epoch = new AbortController();
  account.get.mockResolvedValue(null);
  account.put.mockResolvedValue({ revision: 1 });
});
afterEach(async () => {
  account.epoch.abort();
  if (root) await act(() => root?.unmount());
  root = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(strict = false) {
  root = createRoot(document.createElement("div"));
  const owner = createElement(AccountSettingsProvider, {
    serverReadGeneration: 0,
    serverValue: {
      theme: "ink-jade",
      language: "en",
      statsForNerds: false,
      workingSetSyncEnabled: true,
    },
    children: null,
  });
  await act(() => root?.render(strict ? createElement(StrictMode, null, owner) : owner));
  hydrateWorkingSet("project", { status: "absent" }, true);
  replaceRecentRoutes("project", [route("doc")]);
}
it.each([
  "abort",
])("working-set owner releases its subscription and ignores hints after account %s", async (end) => {
  await mount();
  if (end === "abort") account.epoch.abort();
  else {
    await act(() => root?.unmount());
    root = undefined;
  }
  expect(account.stop).toHaveBeenCalledTimes(1);
  // Even a queued callback from the still-mounted shared shell is harmless.
  account.listener?.("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(account.get).not.toHaveBeenCalled();
  expect(account.put).not.toHaveBeenCalled();
});
it("committed subscription rebinds after StrictMode effect cleanup", async () => {
  await mount(true);
  account.listener?.("suspect-offline");
  expect(account.get).not.toHaveBeenCalled();
  expect(account.put).not.toHaveBeenCalled();
  account.listener?.("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(account.get).toHaveBeenCalledWith("project");
  expect(account.put).toHaveBeenCalledWith(
    "project",
    { recentRoutes: [route("doc")] },
    { keepalive: false },
  );
  expect(account.put).toHaveBeenCalledTimes(1);
  const stops = account.stop.mock.calls.length;
  await unmount();
  expect(account.stop).toHaveBeenCalledTimes(stops + 1);
});

function route(id: string) {
  const value = buildWorkingSetRoute(id, "unfiled", `/${id}.md`, null);
  if (!value) throw new Error("Expected route");
  return value;
}
function holdNextPut() {
  let finish!: (response: { revision: number }) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  account.put.mockReturnValueOnce(pending);
  return finish;
}
async function unmount() {
  account.epoch.abort();
  await act(() => root?.unmount());
  root = undefined;
}
it.each([
  true,
])("account transition drains the new account queue after the old PUT (StrictMode=%s)", async (strict) => {
  const finish = holdNextPut();
  await mount();
  window.dispatchEvent(new Event("pagehide"));
  expect(account.put).toHaveBeenCalledTimes(1);
  await unmount();
  account.id += 1;
  account.epoch = new AbortController();
  await mount(strict);
  account.listener?.("retry-now");
  await vi.advanceTimersByTimeAsync(4_000);
  finish({ revision: 1 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(account.get).toHaveBeenCalledTimes(1);
  expect(account.put).toHaveBeenCalledTimes(2);
});
