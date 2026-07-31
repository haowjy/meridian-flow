import { describe, expect, it } from "vitest";

import { reduceAssetImageLoadFailure } from "./asset-image-render-state";

describe("asset image load failure", () => {
  it("allows one automatic signed-URL refresh, then requires manual retry", () => {
    const first = reduceAssetImageLoadFailure({ automaticRefreshUsed: false });
    const second = reduceAssetImageLoadFailure(first.state);

    expect(first).toEqual({
      state: { automaticRefreshUsed: true },
      action: "refresh",
    });
    expect(second).toEqual({
      state: { automaticRefreshUsed: true },
      action: "error",
    });
  });

  it("ignores a failure while a load is in flight: the URL on screen is the one being replaced", () => {
    const spent = { automaticRefreshUsed: true };

    expect(reduceAssetImageLoadFailure({ automaticRefreshUsed: false }, true)).toEqual({
      state: { automaticRefreshUsed: false },
      action: "ignore",
    });
    // Even with the budget spent, a refresh already running is the answer —
    // this is the window a signed URL expires in, so erroring here would put a
    // placeholder over a picture that is about to load.
    expect(reduceAssetImageLoadFailure(spent, true)).toEqual({ state: spent, action: "ignore" });
  });
});
