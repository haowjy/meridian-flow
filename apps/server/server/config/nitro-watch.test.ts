import { describe, expect, it } from "vitest";
import nitroConfig from "../../nitro.config";

describe("Nitro dev watcher", () => {
  it("ignores structured event logs written under the repository log directory", () => {
    expect(nitroConfig.watchOptions?.ignored).toEqual(expect.arrayContaining(["**/logs/**"]));
  });
});
