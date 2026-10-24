/**
 * Link policy behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - internal-link normalization and labeling policy
 */
import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { createLinkAnswerCache, type LinkAnswer, type LinkQuestion } from "./link-resolution";

import { classifyLinkTarget, linkTargetLabel, normalizeLinkHref } from "./link-target";

describe("normalizeLinkHref", () => {
  it.each(["Chapter 13"])("keeps the extensionless document name %s internal", (written) => {
    expect(normalizeLinkHref(written)).toBe(written);
    expect(classifyLinkTarget(normalizeLinkHref(written) ?? "")?.kind).toBe("relative");
  });

  it.each(["Vol. 2"])("keeps the dotted document name %s internal", (written) => {
    expect(normalizeLinkHref(written)).toBe(written);
  });

  it.each(["chapter-213.md"])("keeps an explicit relative file name %s internal", (written) => {
    expect(normalizeLinkHref(written)).toBe(written);
  });

  it("keeps a Context URI and a scheme URL as written", () => {
    expect(normalizeLinkHref("manuscript://The Second Gate")).toBe("manuscript://The Second Gate");
    expect(normalizeLinkHref("https://example.com")).toBe("https://example.com");
  });
});

it("keeps bare hosts external without requiring extensions on internal names", () => {
  expect(normalizeLinkHref("example.com/data.json")).toBe("https://example.com/data.json");
  expect(normalizeLinkHref("example.com/data.png")).toBe("https://example.com/data.png");
  expect(normalizeLinkHref("example.json")).toBe("https://example.json");
  expect(normalizeLinkHref("Chapter 13")).toBe("Chapter 13");
  expect(normalizeLinkHref("The Second Gate")).toBe("The Second Gate");
});

it("labels an escaped literal # before interpreting an href section", () => {
  expect(linkTargetLabel({ kind: "relative", path: "Chapter%2313.md" })).toBe("Chapter#13");
  expect(linkTargetLabel({ kind: "relative", path: "Chapter%2313.md#opening" })).toBe(
    "Chapter#13#opening",
  );
});

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
  const resolution = createLinkAnswerCache();
  let oldAnswer: (answers: LinkAnswer[]) => void = () => {};
  let newAnswer: (answers: LinkAnswer[]) => void = () => {};
  resolution.registerResolver({ remote: () => new Promise((done) => (oldAnswer = done)) });
  let settled: unknown = "waiting";
  void resolution.resolve(KAEL_LINK).then((entry) => (settled = entry));
  // The new generation shows a provisional answer; the click still waits for
  // the server, and the old generation's late gone must not replace it.
  resolution.registerResolver({
    local: () => ({ kind: "ask", provisional: { state: "document", document: KAEL } }),
    remote: () => new Promise((done) => (newAnswer = done)),
  });

  oldAnswer([{ state: "gone", document: null }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe("waiting");
  expect(resolution.read(KAEL_LINK)).toEqual({ state: "document", document: KAEL });

  newAnswer([{ state: "document", document: KAEL }]);
  await vi.waitFor(() => expect(settled).toEqual({ state: "document", document: KAEL }));
});

it("keeps two refs sharing an href apart", async () => {
  // The old Kael was deleted and a new document now sits at the same address:
  // the link to the old one is gone, the link to the new one resolves.
  const resolution = createLinkAnswerCache();
  const asked: LinkQuestion[][] = [];
  resolution.registerResolver({
    remote: async (questions) => {
      asked.push([...questions]);
      return questions.map(({ ref }) =>
        ref === KAEL_LINK.ref
          ? { state: "document", document: KAEL }
          : { state: "gone", document: null },
      );
    },
  });
  const gone = { ref: `doc:${OLD_KAEL_ID}`, href: "manuscript://Kael.md" };

  resolution.request([KAEL_LINK, gone]);
  await vi.waitFor(() => expect(resolution.read(gone)?.state).toBe("gone"));
  expect(resolution.read(KAEL_LINK)).toEqual({ state: "document", document: KAEL });
  expect(asked).toEqual([
    [
      { ref: KAEL_LINK.ref, target: { kind: "scheme", uri: "manuscript://Kael.md" } },
      { ref: gone.ref, target: { kind: "scheme", uri: "manuscript://Kael.md" } },
    ],
  ]);
});
