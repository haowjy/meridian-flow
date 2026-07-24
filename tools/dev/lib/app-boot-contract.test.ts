import { describe, expect, it } from "vitest";
import { routeContractFailure } from "./app-boot-contract";

describe("routeContractFailure", () => {
  it("refuses the historical foreign-listener 404/404 false positive", () => {
    expect(
      routeContractFailure({
        path: "/",
        expectedStatus: 307,
        actualStatus: 404,
        body: "not found",
      }),
    ).toMatch(/expected 307, received 404/);
    expect(
      routeContractFailure({
        path: "/login",
        expectedStatus: 200,
        actualStatus: 404,
        body: "not found",
        bodyMarker: "Meridian",
      }),
    ).toMatch(/expected 200, received 404/);
  });

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
