// @vitest-environment jsdom
/** The "Stats for nerds" preference: off by default, device-local, shared across tabs. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeStatsForNerds,
  resolveStatsForNerds,
  STATS_FOR_NERDS_STORAGE_KEY,
  subscribeStatsForNerds,
} from "./stats-for-nerds";

afterEach(() => {
  changeStatsForNerds(false);
  localStorage.clear();
});

describe("stats for nerds", () => {
  it("is off by default", () => {
    expect(resolveStatsForNerds()).toBe(false);
  });

  it("turns on and off, persists on this device, and tells subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStatsForNerds(listener);
    changeStatsForNerds(true);
    expect(resolveStatsForNerds()).toBe(true);
    expect(localStorage.getItem(STATS_FOR_NERDS_STORAGE_KEY)).toBe("1");
    changeStatsForNerds(false);
    expect(resolveStatsForNerds()).toBe(false);
    expect(localStorage.getItem(STATS_FOR_NERDS_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("follows a change made in another tab, telling each subscriber once", () => {
    const listeners = [vi.fn(), vi.fn(), vi.fn()];
    const unsubscribes = listeners.map(subscribeStatsForNerds);
    localStorage.setItem(STATS_FOR_NERDS_STORAGE_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: STATS_FOR_NERDS_STORAGE_KEY }));
    expect(resolveStatsForNerds()).toBe(true);
    for (const listener of listeners) expect(listener).toHaveBeenCalledOnce();
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
});
