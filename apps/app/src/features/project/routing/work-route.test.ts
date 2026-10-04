/** The No Work row id must not become an unavailable named Work in the Editor. */
import { parseRequestId } from "@meridian/contracts/request-id";
import { expect, it } from "vitest";
import { resolveRouteWork } from "./work-route";

it("reads the No Work row id as No Work", () => {
  const noWorkId = parseRequestId("00000000-0000-4000-8000-000000000009");
  if (!noWorkId) throw new Error("Invalid fixture");
  expect(
    resolveRouteWork(
      { kind: "id", id: noWorkId },
      { status: "ready", entries: [], creations: new Map(), isFetching: false, noWorkId },
    ),
  ).toEqual({ status: "none" });
});
