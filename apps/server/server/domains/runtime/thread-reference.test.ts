/** Thread references describe only the source metadata that exists. */
import { expect, it } from "vitest";
import { threadReferenceText } from "./thread-reference.js";

it("renders activity without a leading comma when title and Agent are absent", () => {
  expect(threadReferenceText({ ref: "c1", lastActivityAt: "2026-09-30T18:42:00.000Z" })).toContain(
    "\nlast active 2026-09-30 18:42 UTC.",
  );
  expect(
    threadReferenceText({ ref: "c1", lastActivityAt: "2026-09-30T18:42:00.000Z" }),
  ).not.toContain("\n,");
});

it("separates identity and activity details with one comma", () => {
  expect(
    threadReferenceText({
      ref: "p2",
      title: "Continuity",
      agentName: "Critic",
      lastActivityAt: "2026-09-30T18:42:00.000Z",
    }),
  ).toContain('"Continuity" (Agent: Critic), last active 2026-09-30 18:42 UTC.');
});
