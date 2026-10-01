// @vitest-environment jsdom
/** The text-size preference follows another tab's change through the shared storage listener. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeTextSize,
  subscribeTextSize,
  TEXT_SIZE_ATTRIBUTE,
  TEXT_SIZE_STORAGE_KEY,
} from "./text-size";

afterEach(() => {
  changeTextSize("md");
  localStorage.clear();
});

describe("text size", () => {
  it("applies another tab's size here and tells each subscriber once", () => {
    const listeners = [vi.fn(), vi.fn()];
    const unsubscribes = listeners.map(subscribeTextSize);
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "lg");
    window.dispatchEvent(new StorageEvent("storage", { key: TEXT_SIZE_STORAGE_KEY }));
    expect(document.documentElement.getAttribute(TEXT_SIZE_ATTRIBUTE)).toBe("lg");
    for (const listener of listeners) expect(listener).toHaveBeenCalledOnce();
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
});
