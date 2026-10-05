// @vitest-environment jsdom
/** Account-owned recovery subscriptions preserve working-set write lineage. */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  hydrateWorkingSet,
  readRecentRoutes,
  replaceRecentRoutes,
} from "@/client/working-set/driver";
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
  account.listener?.("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(account.put).toHaveBeenCalledTimes(1);
});

function route(id: string) {
  const value = buildWorkingSetRoute(id, "unfiled", `/${id}.md`, null);
  if (!value) throw new Error("Expected route");
  return value;
}
async function unmount() {
  account.epoch.abort();
  await act(() => root?.unmount());
  root = undefined;
}
it.each([
  false,
  true,
])("same-account remount preserves newer recency while the old PUT drains (StrictMode=%s)", async (strict) => {
  let finish!: (response: { revision: number }) => void;
  account.put.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  replaceRecentRoutes("project", [route("old")]);
  window.dispatchEvent(new Event("pagehide"));
  expect(account.put).toHaveBeenCalledTimes(1);
  await unmount();
  account.epoch = new AbortController();
  await mount(strict);
  replaceRecentRoutes("project", [route("new")]);
  account.get.mockResolvedValue({ revision: 1, recentRoutes: [route("old")] });
  await vi.advanceTimersByTimeAsync(4_000);
  finish({ revision: 1 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(readRecentRoutes("project")).toEqual([route("new")]);
  expect(account.put).toHaveBeenCalledTimes(2);
  expect(account.put.mock.calls[1]?.[1]).toEqual({ recentRoutes: [route("new")] });
});
it.each([
  false,
  true,
])("account transition drains the new account queue after the old PUT (StrictMode=%s)", async (strict) => {
  let finish!: (response: { revision: number }) => void;
  account.put.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
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
