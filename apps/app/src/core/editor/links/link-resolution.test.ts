/** A waiter carried into a new generation settles from the new answer only. */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { expect, it, vi } from "vitest";

import { createLinkResolution } from "./link-resolution";

const KAEL: ResolvedDocumentLink = {
  documentId: "doc-kael",
  title: "Kael",
  scheme: "manuscript",
  path: "Kael.md",
  uri: "manuscript://Kael.md",
  workId: null,
};

it("ignores the old generation answering late, after its waiter was carried", async () => {
  const resolution = createLinkResolution();
  let oldAnswer: (document: ResolvedDocumentLink | null) => void = () => {};
  let newAnswer: (document: ResolvedDocumentLink | null) => void = () => {};
  resolution.registerResolver(() => new Promise((done) => (oldAnswer = done)));
  let settled: unknown = "waiting";
  void resolution.resolve("manuscript://Kael.md").then((entry) => (settled = entry));
  resolution.registerResolver(() => new Promise((done) => (newAnswer = done)));

  oldAnswer(null);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe("waiting");

  newAnswer(KAEL);
  await vi.waitFor(() => expect(settled).toEqual({ state: "resolved", document: KAEL }));
});
