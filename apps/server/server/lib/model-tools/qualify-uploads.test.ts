import { expect, it } from "vitest";
import { qualifyBareUploads } from "./qualify-uploads.js";

it("qualifies bare uploads addresses to the writing chat and keeps qualified ones", () => {
  expect(
    qualifyBareUploads("![seal](uploads://seal.png) [map](uploads://@/c2/map.png)", "c15"),
  ).toBe("![seal](uploads://@/c15/seal.png) [map](uploads://@/c2/map.png)");
});
