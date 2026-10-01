/** One batched question per pass for every link a surface shows. */

import { describe, expect, it, vi } from "vitest";

import { createLinkRequester } from "./link-requester";
import { createLinkResolution } from "./link-resolution";

const tick = () => new Promise<void>((done) => queueMicrotask(done));

describe("createLinkRequester", () => {
  it("asks about every shown link in one request", async () => {
    const resolution = createLinkResolution();
    const resolver = vi.fn(async () => null);
    resolution.registerResolver(resolver);
    const request = vi.spyOn(resolution, "request");
    const requester = createLinkRequester(resolution);

    for (const name of ["Kael", "Ilsever", "Kael"]) requester.watch(`[[${name}]]`);
    await tick();

    // One batched question for the set; the pass its own publish triggers
    // asks nothing new, which is where the loop ends.
    expect([...(request.mock.calls[0]?.[0] ?? [])]).toEqual([
      "manuscript://Kael.md",
      "manuscript://Ilsever.md",
    ]);
    expect(request.mock.calls.length).toBeLessThanOrEqual(2);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("asks a new generation again, and stops once nothing is shown", async () => {
    const cache = createLinkResolution();
    const requester = createLinkRequester(cache);
    const first = vi.fn(async () => null);
    cache.registerResolver(first);
    const stop = requester.watch("manuscript://Kael.md");
    await tick();
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn(async () => null);
    cache.registerResolver(second);
    await tick();
    expect(second).toHaveBeenCalledTimes(1);

    stop();
    const third = vi.fn(async () => null);
    cache.registerResolver(third);
    await tick();
    expect(third).not.toHaveBeenCalled();
  });
});
