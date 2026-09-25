import { describe, expect, it } from "vitest";
import {
  completeHttpRequest,
  inFlightHttpRequestCount,
  isHttpRequestAdmissionStopped,
  isHttpRequestAdmitted,
  stopHttpRequestAdmission,
  trackHttpRequest,
  waitForHttpRequestDrain,
} from "./http-drain.js";

describe("HTTP shutdown drain", () => {
  it("keeps admitted work alive, rejects later requests, and resolves when it finishes", async () => {
    const admittedRequest = {};
    const rejectedRequest = {};

    expect(trackHttpRequest(admittedRequest)).toBe(true);
    expect(isHttpRequestAdmitted(admittedRequest)).toBe(true);
    expect(inFlightHttpRequestCount()).toBe(1);
    await expect(waitForHttpRequestDrain(1)).rejects.toThrow("1 in-flight HTTP request");

    stopHttpRequestAdmission();
    expect(isHttpRequestAdmissionStopped()).toBe(true);
    expect(trackHttpRequest(rejectedRequest)).toBe(false);
    expect(isHttpRequestAdmitted(rejectedRequest)).toBe(false);

    const drained = waitForHttpRequestDrain(100);
    completeHttpRequest(admittedRequest);
    await expect(drained).resolves.toBeUndefined();
    expect(inFlightHttpRequestCount()).toBe(0);
  });
});
