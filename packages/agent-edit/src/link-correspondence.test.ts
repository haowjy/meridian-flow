// Link correspondence contracts: reviewer examples, normalization, reorder identity and exhaustive ranking.
import { expect, it } from "vitest";
import {
  type Binding,
  type CorrespondenceInput,
  correspondLinks,
  correspondLinksWithDiagnostics,
} from "./link-correspondence.js";
import { reviewerFixtures } from "./test-support/link-correspondence-fixtures.js";

const normalize = (href: string) => (href.startsWith("https:") ? null : href);
const old = (label: string, ref: string, current: string, live = true) => ({
  label,
  ref,
  current,
  live,
});
const written = (label: string, href: string) => ({ label, href });
const seen = (ref: string, address: string, at: number, holderUri = "holder.md") => ({
  ref,
  address,
  at,
  holderUri,
});
const input = (values: Partial<CorrespondenceInput>): CorrespondenceInput => ({
  old: [],
  written: [],
  shown: [],
  holderUri: "holder.md",
  normalize,
  isLive: () => true,
  ...values,
});

/** Deliberately exhaustive oracle: no components, assignment duals, uncrossing or pruning. */
function exhaustive(values: CorrespondenceInput): Binding[] {
  const history = (ref: string) =>
    values.shown.filter((showing) => showing.ref === ref).sort((a, b) => b.at - a.at);
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
      for (let k = 0; k < j; k++) if (pairs[k] >= 0 && pairs[k] < i) score[5]++;
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
        Number(values.isLive(b.ref)) - Number(values.isLive(a.ref)) ||
        b.at - a.at ||
        a.ref.localeCompare(b.ref),
    );
    return matching[0] ? { pass: 2, ref: matching[0].ref } : { pass: 3 };
  });
}

it("implements all r7 reviewer bindings, normalization and the exhaustive global ranking table", () => {
  expect(reviewerFixtures).toHaveLength(28);
  for (const fixture of reviewerFixtures) {
    const values = input({ ...fixture, isLive: (ref) => fixture.live.includes(ref) });
    expect.soft(correspondLinks(values), fixture.name).toEqual(fixture.expected);
    expect.soft(correspondLinksWithDiagnostics(values).exact, fixture.name).toBe(true);
  }
  const cases: Array<{ name: string; values: CorrespondenceInput; expected: Binding[] }> = [
    {
      name: "r7 strong precedence sacrifices two weak historical continuations",
      values: input({
        old: [old("Alpha", "D", "a.md"), old("Beta", "E", "c.md")],
        written: [written("Beta", "a.md"), written("Alpha", "b.md")],
        shown: [
          seen("D", "b.md", 1),
          seen("E", "a.md", 1),
          seen("D", "a.md", 2),
          seen("E", "c.md", 2),
        ],
      }),
      expected: [{ pass: 1, occurrence: 0 }, { pass: 3 }],
    },
    {
      name: "r7 distinct labels erased by whole replacements use document order",
      values: input({
        old: [old("Alpha", "D", "c.md"), old("Beta", "E", "a.md")],
        written: [written("X", "a.md"), written("Y", "a.md")],
        shown: [seen("D", "a.md", 1), seen("E", "a.md", 2)],
      }),
      expected: [
        { pass: 1, occurrence: 0 },
        { pass: 1, occurrence: 1 },
      ],
    },
    {
      name: "r7 unmatched duplicate reuses latest showing in pass 2",
      values: input({
        old: [old("Target", "D", "c.md")],
        written: [written("Target", "a.md"), written("Target", "a.md")],
        shown: [seen("D", "a.md", 1)],
      }),
      expected: [
        { pass: 1, occurrence: 0 },
        { pass: 2, ref: "D" },
      ],
    },
    {
      name: "r7 pair count outranks exact labels at equal strength",
      values: input({
        old: [old("Alpha", "D", "d.md"), old("Beta", "E", "e.md")],
        written: [written("Alpha", "a.md"), written("X", "b.md")],
        shown: [
          seen("D", "a.md", 1),
          seen("D", "b.md", 2),
          seen("D", "d.md", 3),
          seen("E", "a.md", 1),
          seen("E", "e.md", 3),
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
        old: [old("A", "D", "manuscript://now/T.md")],
        written: [written("X", "T.md"), written("Y", "manuscript://now/T.md")],
        shown: [
          seen("D", "manuscript://one/T.md", 1, "manuscript://one/H.md"),
          seen("D", "manuscript://two/T.md", 2, "manuscript://two/H.md"),
        ],
        holderUri: "manuscript://now/H.md",
        normalize: (href, holder) => new URL(href, holder).href,
      }),
      expected: [{ pass: 1, occurrence: 0 }, { pass: 3 }],
    },
    {
      name: "historical relative address remains weak when latest relative form differs",
      values: input({
        old: [old("A", "D", "manuscript://now/T.md")],
        written: [written("X", "T.md")],
        shown: [
          seen("D", "manuscript://one/T.md", 1, "manuscript://one/H.md"),
          seen("D", "manuscript://two/R.md", 2, "manuscript://two/H.md"),
        ],
        holderUri: "manuscript://now/H.md",
        normalize: (href, holder) => new URL(href, holder).href,
      }),
      expected: [{ pass: 1, occurrence: 0 }],
    },
    {
      name: "pass 2 uses current liveness before recency, never a stale showing",
      values: input({
        written: [written("X", "a.md"), written("Y", "vacated.md")],
        shown: [
          seen("gone", "a.md", 8),
          seen("live", "a.md", 1),
          seen("moved", "vacated.md", 9),
          seen("moved", "b.md", 10),
        ],
        isLive: (ref) => ref !== "gone",
      }),
      expected: [{ pass: 2, ref: "live" }, { pass: 3 }],
    },
    {
      name: "pass 2 normalizes against showing holder and chooses latest live ref",
      values: input({
        written: [written("X", "T.md")],
        shown: [
          seen("older", "manuscript://one/T.md", 1, "manuscript://one/H.md"),
          seen("newer", "manuscript://two/T.md", 2, "manuscript://two/H.md"),
        ],
        holderUri: "manuscript://now/H.md",
        normalize: (href, holder) => new URL(href, holder).href,
      }),
      expected: [{ pass: 2, ref: "newer" }],
    },
    {
      name: "order agreements are global, not independently completed per component",
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
        old: [old("Alpha", "ahead:opaque", "a.md"), old("Beta", "ahead:opaque", "a.md")],
        written: [written("Beta", "a.md")],
        shown: [seen("ahead:opaque", "a.md", 1)],
      }),
      expected: [{ pass: 1, occurrence: 1 }],
    },
    {
      name: "pass 1 uses occurrence liveness before document order",
      values: input({
        old: [old("A", "gone", "a.md", false), old("B", "live", "a.md")],
        written: [written("X", "a.md")],
        isLive: () => false,
      }),
      expected: [{ pass: 1, occurrence: 1 }],
    },
    {
      name: "pass 2 equal recency and liveness never depend on showing enumeration order",
      values: input({
        written: [written("X", "a.md")],
        shown: [seen("z", "a.md", 1), seen("a", "a.md", 1)],
      }),
      expected: [{ pass: 2, ref: "a" }],
    },
    {
      name: "interchangeable written rows select live columns with tied boundary alternatives",
      values: input({
        old: [old("A", "gone", "a.md", false), old("B", "one", "a.md"), old("C", "two", "a.md")],
        written: [written("X", "a.md"), written("Y", "a.md")],
      }),
      expected: [
        { pass: 1, occurrence: 1 },
        { pass: 1, occurrence: 2 },
      ],
    },
    {
      name: "interchangeable old columns select exact written rows before document order",
      values: input({
        old: [old("Target", "D", "a.md")],
        written: [written("Unknown", "a.md"), written("Target", "a.md"), written("Target", "a.md")],
      }),
      expected: [{ pass: 3 }, { pass: 1, occurrence: 0 }, { pass: 3 }],
    },
    {
      name: "row continuity ranks survive the interchangeable-column fast path",
      values: input({
        old: [old("Target", "D", "a.md"), old("Target", "E", "a.md")],
        written: [
          written("T", "a.md"),
          written("Target expanded", "a.md"),
          written("Target", "a.md"),
        ],
      }),
      expected: [{ pass: 3 }, { pass: 1, occurrence: 0 }, { pass: 1, occurrence: 1 }],
    },
    {
      name: "empty write is an unlink, not a new assignment",
      values: input({ old: [old("A", "D", "a.md")], shown: [seen("D", "a.md", 1)] }),
      expected: [],
    },
  ];
  for (const row of cases) {
    expect.soft(correspondLinks(row.values), row.name).toEqual(row.expected);
    expect.soft(correspondLinksWithDiagnostics(row.values).exact, row.name).toBe(true);
  }

  // Deterministic generated oracle rows cover overlapping histories, repeated addresses,
  // cardinality differences, continuity, liveness and interleaved components.
  let state = 729730;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
  const labels = ["", "X", "XY", "YX", "XYZ", "Target", "Target expanded"];
  for (let row = 0; row < 1000; row++) {
    const n = random(6);
    const m = random(6);
    const olds = Array.from({ length: n }, (_, i) =>
      old(labels[random(labels.length)], `ref${i}`, `addr${random(3)}`, random(2) === 1),
    );
    const values = input({
      old: olds,
      written: Array.from({ length: m }, () =>
        written(labels[random(labels.length)], `addr${random(4)}`),
      ),
      shown: olds.flatMap(({ ref }) =>
        Array.from({ length: random(3) }, (_, at) => seen(ref, `addr${random(3)}`, at)),
      ),
      isLive: (ref) => olds.find((occurrence) => occurrence.ref === ref)?.live ?? false,
    });
    const result = correspondLinksWithDiagnostics(values);
    expect
      .soft(result.bindings, `exhaustive generated row ${row}: ${JSON.stringify(values)}`)
      .toEqual(exhaustive(values));
    expect.soft(result.exact, `exhaustive generated row ${row}`).toBe(true);
  }
});

function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (values.length === 0) {
    yield [];
    return;
  }
  for (let i = 0; i < values.length; i++) {
    for (const tail of permutations(values.filter((_, j) => i !== j))) yield [values[i], ...tail];
  }
}

it("preserves uniquely identifiable historical-address links in all 153 r7 reorder permutations", () => {
  let count = 0;
  for (let n = 1; n <= 5; n++) {
    const ids = Array.from({ length: n }, (_, i) => i);
    for (const order of permutations(ids)) {
      const values = input({
        old: ids.map((i) => old(`Old ${i}`, `ref${i}`, `new${i}.md`)),
        written: order.map((i) => written(`Entirely changed ${i}`, `old${i}.md`)),
        shown: ids.flatMap((i) => [
          seen(`ref${i}`, `old${i}.md`, 1),
          seen(`ref${i}`, `new${i}.md`, 2),
        ]),
      });
      expect
        .soft(correspondLinks(values), `reorder ${order.join(",")}`)
        .toEqual(order.map((occurrence) => ({ pass: 1, occurrence })));
      count++;
    }
  }
  expect(count).toBe(153);
});
