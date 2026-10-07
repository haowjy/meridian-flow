/** Browser recovery hints are coalesced, staggered, bounded, and disposable. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectivityHints } from "./connectivity-hints";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(random = 0) {
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  const hints = new ConnectivityHints({
    browser,
    document,
    random: () => random,
  });
  hints.start();
  return { browser, document, hints };
}

it("coalesces wakes and injects per-subscriber jitter", async () => {
  const { hints, browser, document } = setup(0.5);
  const listener = vi.fn();
  hints.subscribe({}, listener);
  browser.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  browser.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(199);
  expect(listener).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(listener.mock.calls).toEqual([["retry-now"]]);
  hints.stop();
});

it("rate limits each subscriber without polling or repeated-success storms", async () => {
  const { hints, browser } = setup();
  const first = vi.fn();
  hints.subscribe({}, first);
  browser.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(51);
  const second = vi.fn();
  hints.subscribe({}, second);
  browser.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(51);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_900);
  expect(first).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(first).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(first).toHaveBeenCalledTimes(2);
  browser.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(51);
  expect(first).toHaveBeenCalledTimes(3);
  hints.stop();
});

it("a connection success nudges peers but not itself and only on transitions", async () => {
  const { hints } = setup();
  const source = {};
  const self = vi.fn();
  const peer = vi.fn();
  hints.subscribe(source, self);
  hints.subscribe({}, peer);
  hints.reportConnected(source);
  await vi.advanceTimersByTimeAsync(51);
  expect(self).not.toHaveBeenCalled();
  expect(peer.mock.calls).toEqual([["retry-now"]]);
  await vi.advanceTimersByTimeAsync(3_000);
  hints.reportConnected(source);
  await vi.advanceTimersByTimeAsync(51);
  expect(peer).toHaveBeenCalledTimes(1);
  hints.reportDisconnected(source);
  hints.reportConnected(source);
  await vi.advanceTimersByTimeAsync(51);
  expect(peer).toHaveBeenCalledTimes(2);
  hints.stop();
});

it("offline is immediate, cancels pending nudges, and permits prompt recovery", async () => {
  const { hints, browser } = setup();
  const listener = vi.fn();
  hints.subscribe({}, listener);
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("offline"));
  expect(listener.mock.calls).toEqual([["suspect-offline"]]);
  await vi.advanceTimersByTimeAsync(500);
  expect(listener).toHaveBeenCalledTimes(1);
  browser.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(51);
  expect(listener.mock.calls.at(-1)).toEqual(["retry-now"]);
  hints.stop();
});

it("cleanup removes browser listeners and pending callbacks", async () => {
  const { hints, browser, document } = setup();
  const removeBrowser = vi.spyOn(browser, "removeEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  const listener = vi.fn();
  const unsubscribe = hints.subscribe({}, listener);
  browser.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(50);
  unsubscribe();
  hints.stop();
  expect(removeBrowser.mock.calls.map(([event]) => event)).toEqual([
    "online",
    "focus",
    "pageshow",
    "offline",
  ]);
  expect(removeDocument.mock.calls.map(([event]) => event)).toEqual(["visibilitychange"]);
  browser.dispatchEvent(new Event("offline"));
  await vi.advanceTimersByTimeAsync(500);
  expect(listener).not.toHaveBeenCalled();
});
