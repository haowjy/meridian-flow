/**
 * The resolution cache: answers belong to a link's whole identity and to the
 * generation that asked.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { expect, it, vi } from "vitest";

import { createLinkResolution, type LinkAnswer, type LinkQuestion } from "./link-resolution";

const KAEL_ID = "00000000-0000-4000-8000-00000000000a";
const OLD_KAEL_ID = "00000000-0000-4000-8000-0000000000aa";
const KAEL: ResolvedDocumentLink = {
  documentId: KAEL_ID,
  title: "Kael",
  scheme: "manuscript",
  path: "Kael.md",
  uri: "manuscript://Kael.md",
  workId: null,
};
const KAEL_LINK = { ref: `doc:${KAEL_ID}`, href: "manuscript://Kael.md" };

it("ignores the old generation answering late, after its waiter was carried", async () => {
  const resolution = createLinkResolution();
  let oldAnswer: (answers: LinkAnswer[]) => void = () => {};
  let newAnswer: (answers: LinkAnswer[]) => void = () => {};
  resolution.registerResolver({ remote: () => new Promise((done) => (oldAnswer = done)) });
  let settled: unknown = "waiting";
  void resolution.resolve(KAEL_LINK).then((entry) => (settled = entry));
  resolution.registerResolver({ remote: () => new Promise((done) => (newAnswer = done)) });

  oldAnswer([{ state: "unresolved", document: null }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe("waiting");

  newAnswer([{ state: "resolved", document: KAEL }]);
  await vi.waitFor(() => expect(settled).toEqual({ state: "resolved", document: KAEL }));
});

it("keeps two refs sharing an href apart", async () => {
  // The old Kael was deleted and a new document now sits at the same address:
  // the link to the old one is gone, the link to the new one resolves.
  const resolution = createLinkResolution();
  const asked: LinkQuestion[][] = [];
  resolution.registerResolver({
    remote: async (questions) => {
      asked.push([...questions]);
      return questions.map(({ ref }) =>
        ref === KAEL_LINK.ref
          ? { state: "resolved", document: KAEL }
          : { state: "gone", document: null },
      );
    },
  });
  const gone = { ref: `doc:${OLD_KAEL_ID}`, href: "manuscript://Kael.md" };

  resolution.request([KAEL_LINK, gone]);
  await vi.waitFor(() => expect(resolution.read(gone)?.state).toBe("gone"));
  expect(resolution.read(KAEL_LINK)).toEqual({ state: "resolved", document: KAEL });
  expect(asked).toEqual([
    [
      { ref: KAEL_LINK.ref, target: { kind: "scheme", uri: "manuscript://Kael.md" } },
      { ref: gone.ref, target: { kind: "scheme", uri: "manuscript://Kael.md" } },
    ],
  ]);
});
