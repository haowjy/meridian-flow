/** Project destination placement contracts. */
import { describe, expect, it } from "vitest";

import { placeSurfaces } from "./placement";

describe("placeSurfaces", () => {
  it("places Work like Home with the project rail and persistent chat dock", () => {
    expect(placeSurfaces("work")).toEqual(placeSurfaces("home"));
    expect(placeSurfaces("work").threads.slot).toBe("rail-l");
    expect(placeSurfaces("work").chat.slot).toBe("dock");
  });
});
