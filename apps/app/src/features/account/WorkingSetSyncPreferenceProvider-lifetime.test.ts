// @vitest-environment jsdom
/** Account teardown fences shared recovery and delayed working-set writes. */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hydrateWorkingSet, replaceRecentRoutes } from "@/client/working-set/driver";
import { buildWorkingSetRoute } from "@/client/working-set/store";
import type { ConnectivityHint, ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { WorkingSetSyncPreferenceProvider } from "./WorkingSetSyncPreferenceProvider";

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
vi.mock("./useWorkingSetSyncPreference", () => ({
  useWorkingSetSyncPreference: () => ({ confirmed: true }),
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
  const owner = createElement(WorkingSetSyncPreferenceProvider, {
    serverValue: true,
    children: null,
  });
  await act(() => root?.render(strict ? createElement(StrictMode, null, owner) : owner));
  hydrateWorkingSet("project", { status: "absent" }, true);
  const route = buildWorkingSetRoute("doc", "unfiled", "/Chapter.md", null);
  if (!route) throw new Error("Expected route");
  replaceRecentRoutes("project", [route]);
}
it.each([
  "abort",
  "unmount",
])("working-set owner releases recovery and fences writes on account %s", async (end) => {
  await mount();
  if (end === "abort") account.epoch.abort();
  else {
    await act(() => root?.unmount());
    root = undefined;
  }
  expect(account.stop).toHaveBeenCalledTimes(1);
  // Even a queued callback from the still-mounted shared shell is harmless.
  account.listener?.("retry-now");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pagehide"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(account.put).not.toHaveBeenCalled();
});
it("account abort fences a recovery GET already in flight", async () => {
  await mount();
  let finish!: (row: null) => void;
  account.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  account.listener?.("retry-now");
  expect(account.get).toHaveBeenCalledTimes(1);
  account.epoch.abort();
  finish(null);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(account.put).not.toHaveBeenCalled();
  expect(account.get).toHaveBeenCalledTimes(1);
});
it("committed lifetime can reopen after StrictMode effect cleanup", async () => {
  await mount(true);
  account.listener?.("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(account.put).toHaveBeenCalledTimes(1);
});
