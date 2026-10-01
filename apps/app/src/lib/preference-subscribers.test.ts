// @vitest-environment jsdom
/** A preference's subscribers share one window `storage` listener, attached and removed with them. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPreferenceSubscribers } from "./preference-subscribers";

const KEY = "meridian:test-preference";

function storageListenerCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([type]) => type === "storage").length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPreferenceSubscribers", () => {
  it("attaches one storage listener for many subscribers and removes it after the last", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { subscribe } = createPreferenceSubscribers(KEY, () => undefined);

    const unsubscribes = Array.from({ length: 200 }, () => subscribe(vi.fn()));
    expect(storageListenerCalls(add)).toBe(1);

    for (const unsubscribe of unsubscribes.slice(1)) unsubscribe();
    expect(storageListenerCalls(remove)).toBe(0);
    unsubscribes[0]?.();
    expect(storageListenerCalls(remove)).toBe(1);
    // Unsubscribing twice does not detach anything a later subscriber needs.
    unsubscribes[0]?.();
    expect(storageListenerCalls(remove)).toBe(1);

    // A new first subscriber attaches it again.
    const unsubscribe = subscribe(vi.fn());
    expect(storageListenerCalls(add)).toBe(2);
    unsubscribe();
  });

  it("reads another tab's change once and tells each subscriber once", () => {
    const onOtherTabChange = vi.fn();
    const { subscribe } = createPreferenceSubscribers(KEY, onOtherTabChange);
    const listeners = [vi.fn(), vi.fn(), vi.fn()];
    const unsubscribes = listeners.map(subscribe);

    window.dispatchEvent(new StorageEvent("storage", { key: "meridian:something-else" }));
    expect(onOtherTabChange).not.toHaveBeenCalled();

    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(onOtherTabChange).toHaveBeenCalledOnce();
    for (const listener of listeners) expect(listener).toHaveBeenCalledOnce();

    for (const unsubscribe of unsubscribes) unsubscribe();
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(onOtherTabChange).toHaveBeenCalledOnce();
  });

  it("notifies this tab's subscribers without touching storage", () => {
    const { notify, subscribe } = createPreferenceSubscribers(KEY, () => undefined);
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    notify();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    notify();
    expect(listener).toHaveBeenCalledOnce();
  });
});
