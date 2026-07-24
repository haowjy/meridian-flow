import { describe, expect, it } from "vitest";
import nitroConfig from "../../nitro.config";

describe("Nitro dev watcher", () => {
  it("excludes structured logs at the active Rolldown watcher seam", () => {
    const watch = nitroConfig.rolldownConfig?.watch;
    expect(watch ? watch.exclude : undefined).toEqual([expect.stringMatching(/\/logs\/\*\*$/)]);
  });
});
