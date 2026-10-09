import { describe, expect, it } from "vitest";
import { routeContractFailure } from "./app-boot-contract";

describe("routeContractFailure", () => {
  it("requires the app-specific login marker", () => {
    expect(
      routeContractFailure({
        path: "/login",
        expectedStatus: 200,
        actualStatus: 200,
        body: "<html>foreign listener</html>",
        bodyMarker: "Meridian",
      }),
    ).toMatch(/did not contain app marker/);
  });
});
