import { describe, expect, it } from "vitest";

import { createAgentNameStore } from "./agent-name-store";

describe("agent name store", () => {
  it("notifies on a changed name and stays quiet when the set is equivalent", () => {
    const store = createAgentNameStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.replace(new Map([["thread-1", "Seawall rewrite"]]));
    expect(store.get("thread-1")).toBe("Seawall rewrite");
    expect(notifications).toBe(1);

    // The thread list refetches on every turn start, stream frame and
    // disposition, handing us a fresh map with identical contents each time.
    store.replace(new Map([["thread-1", "Seawall rewrite"]]));
    expect(notifications).toBe(1);

    store.replace(new Map([["thread-1", "Seawall rewrite, pass 2"]]));
    expect(notifications).toBe(2);

    store.replace(new Map());
    expect(store.get("thread-1")).toBeUndefined();
    expect(notifications).toBe(3);
  });

  it("stops notifying an unsubscribed listener", () => {
    const store = createAgentNameStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    unsubscribe();
    store.replace(new Map([["thread-1", "Seawall rewrite"]]));
    expect(notifications).toBe(0);
  });
});
