/**
 * Link correspondence contracts: ranking counterexamples, normalization, reorder identity and exhaustive ranking.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Six-component link correspondence ranking (kb/decisions/documents/identity/link-identity.md)
 */
// The 28 r7 reviewer fixtures run on the real write path (assign-refs.test.ts).
import { expect, it } from "vitest";
import {
  type CorrespondenceInput,
  correspondLinks,
  type LinkMatch,
  type ShownLink,
} from "./correspondence.js";

const normalize = (href: string) => (href.startsWith("https:") ? null : href);
const old = (label: string, ref: string, current: string, live = true) => ({
  label,
  ref,
  current,
  live,
});
const written = (label: string, href: string) => ({ label, href });
const seen = (ref: string, address: string, at: number, holderUri = "holder") => ({
  ref,
  address,
  at,
  holderUri,
});
const input = (values: Partial<CorrespondenceInput>): CorrespondenceInput => ({
  old: [],
  written: [],
  shown: [],
  holderUri: "holder",
  normalize,
  isLive: () => true,
  ...values,
});

/** Independent exhaustive ranking: no components, assignment duals or alternating paths. */
function exhaustive(values: CorrespondenceInput): LinkMatch[] {
  const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const showingOrder = (a: ShownLink, b: ShownLink) =>
    b.at - a.at ||
    compareText(a.ref, b.ref) ||
    compareText(a.address, b.address) ||
    compareText(a.holderUri, b.holderUri);
  const history = (ref: string | null) =>
    values.shown.filter((showing) => showing.ref === ref).sort(showingOrder);
  const strength = (i: number, j: number) => {
    const occurrence = values.old[i];
    const showings = history(occurrence.ref);
    const view = showings[0];
    const current = values.normalize(values.written[j].href, values.holderUri);
    if (
      view
        ? values.normalize(values.written[j].href, view.holderUri) === view.address
        : current !== null && current === occurrence.current
    )
      return 2;
    return (current !== null && current === occurrence.current) ||
      showings.some(
        (showing) =>
          values.normalize(values.written[j].href, showing.holderUri) === showing.address,
      )
      ? 1
      : 0;
  };
  const rank = (pairs: number[]) => {
    const score = [0, 0, 0, 0, 0, 0];
    pairs.forEach((i, j) => {
      if (i < 0) return;
      const a = values.old[i].label;
      const b = values.written[j].label;
      let prefix = 0;
      while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < Math.min(a.length, b.length) - prefix &&
        a.at(-1 - suffix) === b.at(-1 - suffix)
      )
        suffix++;
      score[0] += Number(strength(i, j) === 2);
      score[1]++;
      score[2] += Number(a === b);
      score[3] += prefix + suffix;
      score[4] += Number(values.old[i].live);
      score[5] -= Math.abs(j * (values.old.length - 1) - i * (values.written.length - 1));
    });
    return score;
  };
  let best = Array<number>(values.written.length).fill(-1);
  let bestRank = rank(best);
  const pairs = [...best];
  const used = new Set<number>();
  const visit = (j: number) => {
    if (j === pairs.length) {
      const score = rank(pairs);
      let better = false;
      for (let k = 0; k < score.length; k++) {
        if (score[k] === bestRank[k]) continue;
        better = score[k] > bestRank[k];
        break;
      }
      if (score.every((value, k) => value === bestRank[k])) {
        for (let k = 0; k < pairs.length; k++) {
          const a = pairs[k] < 0 ? values.old.length : pairs[k];
          const b = best[k] < 0 ? values.old.length : best[k];
          if (a === b) continue;
          better = a < b;
          break;
        }
      }
      if (better) {
        best = [...pairs];
        bestRank = score;
      }
      return;
    }
    // Unmatched-first exploration intentionally differs from production's traversal.
    pairs[j] = -1;
    visit(j + 1);
    values.old.forEach((_, i) => {
      if (used.has(i) || strength(i, j) === 0) return;
      used.add(i);
      pairs[j] = i;
      visit(j + 1);
      used.delete(i);
    });
    pairs[j] = -1;
  };
  visit(0);
  return best.map((occurrence, j) => {
    if (occurrence >= 0) return { pass: 1, occurrence };
    const showings = [...new Set(values.shown.map(({ ref }) => ref))].map((ref) => history(ref)[0]);
    const matching = showings.filter(
      (showing) => values.normalize(values.written[j].href, showing.holderUri) === showing.address,
    );
    matching.sort(
      (a, b) =>
        Number(values.isLive(b.ref, b.address)) - Number(values.isLive(a.ref, a.address)) ||
        showingOrder(a, b),
    );
    return matching[0] ? { pass: 2, ref: matching[0].ref } : { pass: 3 };
  });
}

it("preserves r7 ranking counterexamples, stated ambiguities and historical holder normalization", () => {
  const cases: Array<{ name: string; values: CorrespondenceInput; expected: LinkMatch[] }> = [
    {
      name: "r7 strong precedence sacrifices two weak historical continuations",
      values: input({
        old: [old("Alpha", "D", "a"), old("Beta", "E", "c")],
        written: [written("Beta", "a"), written("Alpha", "b")],
        shown: [seen("D", "b", 1), seen("E", "a", 1), seen("D", "a", 2), seen("E", "c", 2)],
      }),
      expected: [{ pass: 1, occurrence: 0 }, { pass: 3 }],
    },
    {
      name: "r7 distinct labels erased by whole replacements use document order",
      values: input({
        old: [old("Alpha", "D", "c"), old("Beta", "E", "a")],
        written: [written("X", "a"), written("Y", "a")],
        shown: [seen("D", "a", 1), seen("E", "a", 2)],
      }),
      expected: [
        { pass: 1, occurrence: 0 },
        { pass: 1, occurrence: 1 },
      ],
    },
    {
      name: "r7 unmatched duplicate reuses latest showing in pass 2",
      values: input({
        old: [old("Target", "D", "c")],
        written: [written("Target", "a"), written("Target", "a")],
        shown: [seen("D", "a", 1)],
      }),
      expected: [
        { pass: 1, occurrence: 0 },
        { pass: 2, ref: "D" },
      ],
    },
    {
      name: "r7 pair count outranks exact labels at equal strength",
      values: input({
        old: [old("Alpha", "D", "d"), old("Beta", "E", "e")],
        written: [written("Alpha", "a"), written("X", "b")],
        shown: [
          seen("D", "a", 1),
          seen("D", "b", 2),
          seen("D", "d", 3),
          seen("E", "a", 1),
          seen("E", "e", 3),
        ],
      }),
      expected: [
        { pass: 1, occurrence: 1 },
        { pass: 1, occurrence: 0 },
      ],
    },
    {
      name: "holder move normalizes latest and historical showings against their own holders",
      values: input({
        old: [old("A", "D", "manuscript://now/T")],
        written: [written("X", "T"), written("Y", "manuscript://now/T")],
        shown: [
          seen("D", "manuscript://one/T", 1, "manuscript://one/H"),
          seen("D", "manuscript://two/T", 2, "manuscript://two/H"),
        ],
        holderUri: "manuscript://now/H",
        normalize: (href, holder) => new URL(href, holder ?? undefined).href,
      }),
      expected: [{ pass: 1, occurrence: 0 }, { pass: 3 }],
    },
    {
      name: "historical relative address remains weak when latest relative form differs",
      values: input({
        old: [old("A", "D", "manuscript://now/T")],
        written: [written("X", "T")],
        shown: [
          seen("D", "manuscript://one/T", 1, "manuscript://one/H"),
          seen("D", "manuscript://two/R", 2, "manuscript://two/H"),
        ],
        holderUri: "manuscript://now/H",
        normalize: (href, holder) => new URL(href, holder ?? undefined).href,
      }),
      expected: [{ pass: 1, occurrence: 0 }],
    },
    {
      name: "pass 2 uses current liveness before recency, never a stale showing",
      values: input({
        written: [written("X", "a"), written("Y", "vacated")],
        shown: [
          seen("gone", "a", 8),
          seen("live", "a", 1),
          seen("moved", "vacated", 9),
          seen("moved", "b", 10),
        ],
        isLive: (ref) => ref !== "gone",
      }),
      expected: [{ pass: 2, ref: "live" }, { pass: 3 }],
    },
    {
      name: "pass 2 normalizes against showing holder and chooses latest live ref",
      values: input({
        written: [written("X", "T")],
        shown: [
          seen("older", "manuscript://one/T", 1, "manuscript://one/H"),
          seen("newer", "manuscript://two/T", 2, "manuscript://two/H"),
        ],
        holderUri: "manuscript://now/H",
        normalize: (href, holder) => new URL(href, holder ?? undefined).href,
      }),
      expected: [{ pass: 2, ref: "newer" }],
    },
    {
      name: "order displacement uses span-wide indices across compatibility components",
      values: input({
        old: [old("X", "a", "a"), old("X", "b", "b"), old("X", "c", "a")],
        written: [written("Y", "b"), written("Y", "a")],
      }),
      expected: [
        { pass: 1, occurrence: 1 },
        { pass: 1, occurrence: 2 },
      ],
    },
    {
      name: "external hrefs never correspond or reuse a showing",
      values: input({
        old: [old("X", "D", "https://example.com")],
        written: [written("X", "https://example.com")],
        shown: [seen("D", "https://example.com", 1)],
      }),
      expected: [{ pass: 3 }],
    },
    {
      name: "two occurrences of the same opaque ref remain distinct for exact-label matching",
      values: input({
        old: [old("Alpha", "ahead:opaque", "a"), old("Beta", "ahead:opaque", "a")],
        written: [written("Beta", "a")],
        shown: [seen("ahead:opaque", "a", 1)],
      }),
      expected: [{ pass: 1, occurrence: 1 }],
    },
    {
      name: "pass 1 uses occurrence liveness before document order",
      values: input({
        old: [old("A", "gone", "a", false), old("B", "live", "a")],
        written: [written("X", "a")],
        isLive: () => false,
      }),
      expected: [{ pass: 1, occurrence: 1 }],
    },
    {
      name: "pass 2 equal recency and liveness never depend on showing enumeration order",
      values: input({
        written: [written("X", "a")],
        shown: [seen("z", "a", 1), seen("a", "a", 1)],
      }),
      expected: [{ pass: 2, ref: "a" }],
    },
    {
      name: "live targets outrank displacement when a gone occurrence competes with two survivors",
      values: input({
        old: [old("A", "gone", "a", false), old("B", "one", "a"), old("C", "two", "a")],
        written: [written("X", "a"), written("Y", "a")],
      }),
      expected: [
        { pass: 1, occurrence: 1 },
        { pass: 1, occurrence: 2 },
      ],
    },
    {
      name: "exact labels outrank displacement and earliest-written ties",
      values: input({
        old: [old("Target", "D", "a")],
        written: [written("Unknown", "a"), written("Target", "a"), written("Target", "a")],
      }),
      expected: [{ pass: 3 }, { pass: 1, occurrence: 0 }, { pass: 3 }],
    },
    {
      name: "label continuity outranks displacement after exact labels",
      values: input({
        old: [old("Target", "D", "a"), old("Target", "E", "a")],
        written: [written("T", "a"), written("Target expanded", "a"), written("Target", "a")],
      }),
      expected: [{ pass: 3 }, { pass: 1, occurrence: 0 }, { pass: 1, occurrence: 1 }],
    },
    {
      name: "an inserted duplicate never sacrifices latest-view strength",
      values: input({
        old: [old("", "D", "c"), old("A", "D", "c", false)],
        written: [written("A", "a"), written("A", "b"), written("A", "a")],
        shown: [seen("D", "a", 1), seen("D", "b", 2)],
      }),
      expected: [{ pass: 1, occurrence: 0 }, { pass: 1, occurrence: 1 }, { pass: 3 }],
    },
    {
      name: "empty write is an unlink, not a new assignment",
      values: input({ old: [old("A", "D", "a")], shown: [seen("D", "a", 1)] }),
      expected: [],
    },
  ];
  for (const row of cases) {
    expect.soft(correspondLinks(row.values), row.name).toEqual(row.expected);
  }
});

it("matches exhaustive six-component ranking with mixed historical holders and relative hrefs", () => {
  let state = 729730;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
  const pick = <T>(values: readonly T[]) => values[random(values.length)];
  const labels = ["", "X", "XY", "YX", "XYZ", "Target", "Target expanded"];
  const refs = ["Z", "a", "ä", "Ω", "😀"];
  const holders = ["manuscript://p/a/H", "manuscript://p/b/H", "manuscript://p/H"];
  const addresses = [
    "manuscript://p/a/T",
    "manuscript://p/b/T",
    "manuscript://p/T",
    "manuscript://p/a/U",
  ];
  const hrefs = [...addresses, "T", "../T", "U", "a/T", "https://example.com"];
  const normalize = (href: string, holder: string) =>
    href.startsWith("https:") ? null : new URL(href, holder).href;
  for (let row = 0; row < 1000; row++) {
    const n = random(6);
    const m = random(6);
    const olds = Array.from({ length: n }, () =>
      old(pick(labels), pick(refs), pick(addresses), random(2) === 1),
    );
    const observed = [...new Set(olds.map(({ ref }) => ref)), "ahead:new"];
    const live = new Set(observed.filter(() => random(2) === 1));
    const values = input({
      old: olds,
      written: Array.from({ length: m }, () => written(pick(labels), pick(hrefs))),
      shown: observed.flatMap((ref) =>
        Array.from({ length: random(4) }, () =>
          seen(ref, pick(addresses), random(3), pick(holders)),
        ),
      ),
      holderUri: pick(holders),
      normalize,
      isLive: (ref) => live.has(ref),
    });
    expect
      .soft(correspondLinks(values), `exhaustive generated row ${row}: ${JSON.stringify(values)}`)
      .toEqual(exhaustive(values));
  }
});
