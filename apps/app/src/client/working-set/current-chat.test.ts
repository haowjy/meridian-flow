/** Server document continuity never chooses or replaces this browser's current chat. */
import { expect, it } from "vitest";
import { DeviceWorkingSetStore } from "./store";

it("keeps remote thread selections out of a fresh browser and preserves local new chat on adoption", () => {
  const storage = new Map<string, string>();
  const port = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const store = new DeviceWorkingSetStore(port);
  store.setUser("writer");
  store.adopt("project", { recentRoutes: [], lastThreadId: "remote-thread" });
  expect(store.read("project")?.snapshot.lastThreadId).toBeNull();
  store.report("project", null, (snapshot) => ({ ...snapshot, lastThreadId: null, newChat: true }));
  const reloaded = new DeviceWorkingSetStore(port);
  reloaded.setUser("writer");
  reloaded.adopt("project", { recentRoutes: [], lastThreadId: "remote-thread" });
  expect(reloaded.read("project")?.snapshot).toMatchObject({ lastThreadId: null, newChat: true });
});
