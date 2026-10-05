// @vitest-environment jsdom
/** Shared recovery hints re-confirm working-set authority before sending pending changes. */
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectivityHint } from "@/core/transport/connectivity-hints";
import {
  bindWorkingSetSyncLifetime,
  configureWorkingSetSync,
  hydrateWorkingSet,
  replaceRecentRoutes,
} from "./driver";
import { buildWorkingSetRoute } from "./store";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/client/api/projects-api", () => ({
  getProjectWorkingSet: api.get,
  updateProjectWorkingSet: api.put,
}));
afterEach(() => {
  configureWorkingSetSync("account", false);
  vi.clearAllTimers();
  vi.useRealTimers();
});
it("retry-now confirms a suspect baseline and flushes before the report debounce", async () => {
  vi.useFakeTimers();
  localStorage.clear();
  api.get.mockResolvedValue(null);
  api.put.mockResolvedValue({ revision: 1 });
  let callback: (hint: ConnectivityHint) => void = () => {};
  const stop = vi.fn();
  configureWorkingSetSync("account", true);
  const close = bindWorkingSetSyncLifetime(new AbortController().signal, {
    subscribe: (_source, listener) => {
      callback = listener;
      return stop;
    },
    reportConnected: () => {},
    reportDisconnected: () => {},
  });
  hydrateWorkingSet("project", { status: "absent" }, true);
  const route = buildWorkingSetRoute("document", "unfiled", "/Chapter.md", null);
  if (!route) throw new Error("Expected route");
  replaceRecentRoutes("project", [route]);
  callback("suspect-offline");
  expect(api.put).not.toHaveBeenCalled();
  callback("retry-now");
  await vi.advanceTimersByTimeAsync(0);
  expect(api.get).toHaveBeenCalledWith("project");
  expect(api.put).toHaveBeenCalledWith("project", { recentRoutes: [route] }, { keepalive: false });
  close();
  configureWorkingSetSync("account", false);
  expect(stop).toHaveBeenCalledTimes(1);
});
