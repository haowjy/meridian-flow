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
});
