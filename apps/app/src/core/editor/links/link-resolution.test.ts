/**
 * The resolution cache: answers belong to a link's whole identity and to the
 * generation that asked.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { expect, it, vi } from "vitest";

import { followProjectLink } from "@/features/links/follow-link";

import { createLinkResolution, type LinkAnswer, type LinkQuestion } from "./link-resolution";

const KAEL: ResolvedDocumentLink = {
  documentId: "doc-kael",
  title: "Kael",
  scheme: "manuscript",
  path: "Kael.md",
  uri: "manuscript://Kael.md",
  workId: null,
};
const KAEL_LINK = { ref: "doc:doc-kael", href: "manuscript://Kael.md" };

it("ignores the old generation answering late, after its waiter was carried", async () => {
  const resolution = createLinkResolution();
  let oldAnswer: (answers: LinkAnswer[]) => void = () => {};
  let newAnswer: (answers: LinkAnswer[]) => void = () => {};
  resolution.registerResolver(() => new Promise((done) => (oldAnswer = done)));
  let settled: unknown = "waiting";
  void resolution.resolve(KAEL_LINK).then((entry) => (settled = entry));
  resolution.registerResolver(() => new Promise((done) => (newAnswer = done)));

  oldAnswer([{ state: "unresolved", document: null }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe("waiting");

  newAnswer([{ state: "resolved", document: KAEL }]);
  await vi.waitFor(() => expect(settled).toEqual({ state: "resolved", document: KAEL }));
});

it("keeps two refs sharing an href apart, and never follows the gone one", async () => {
  // The old Kael was deleted and a new document now sits at the same address:
  // the link to the old one is gone, the link to the new one resolves.
  const resolution = createLinkResolution();
  const asked: LinkQuestion[][] = [];
  resolution.registerResolver(async (questions) => {
    asked.push([...questions]);
    return questions.map(({ ref }) =>
      ref === "doc:doc-kael"
        ? { state: "resolved", document: KAEL }
        : { state: "gone", document: null },
    );
  });
  const gone = { ref: "doc:doc-old-kael", href: "manuscript://Kael.md" };

  resolution.request([KAEL_LINK, gone]);
  await vi.waitFor(() => expect(resolution.read(gone)?.state).toBe("gone"));
  expect(resolution.read(KAEL_LINK)).toEqual({ state: "resolved", document: KAEL });
  expect(asked).toEqual([
    [
      { ref: "doc:doc-kael", target: { kind: "scheme", uri: "manuscript://Kael.md" } },
      { ref: "doc:doc-old-kael", target: { kind: "scheme", uri: "manuscript://Kael.md" } },
    ],
  ]);

  const events: string[] = [];
  await followProjectLink({
    target: { kind: "scheme", uri: gone.href },
    ref: gone.ref,
    gesture: "current",
    resolution,
    open: async (document) => {
      events.push(`open:${document.documentId}`);
    },
    reporter: {
      report: (outcome) => events.push(`report:${outcome.state}`),
      clear: () => events.push("clear"),
    },
    signal: new AbortController().signal,
  });
  expect(events).toEqual(["clear"]);
});
