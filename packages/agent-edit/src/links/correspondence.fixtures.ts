// Round-7 reviewer fixtures; fresh resolution is deliberately left to the caller.
import type { LinkMatch, OldOccurrence, ShownLink, WrittenLink } from "./correspondence.js";

export interface Fixture {
  name: string;
  old: OldOccurrence[];
  written: WrittenLink[];
  shown: ShownLink[];
  live: string[];
  expected: LinkMatch[];
}
const old = (label: string, ref: string, current: string, live = true): OldOccurrence => ({
  label,
  ref,
  current,
  live,
});
const written = (label: string, href: string): WrittenLink => ({ label, href });
const shown = (ref: string, address: string, at: number): ShownLink => ({
  ref,
  address,
  at,
  holderUri: "holder.md",
});
const fixture = (
  name: string,
  old: OldOccurrence[],
  written: WrittenLink[],
  shown: ShownLink[],
  live: string[],
  expected: LinkMatch[],
): Fixture => ({ name, old, written, shown, live, expected });

export const reviewerFixtures: Fixture[] = [
  fixture(
    "r1 stale label edit, E took a.md",
    [old("Old label", "doc:D", "b.md")],
    [written("Renamed label", "a.md")],
    [shown("doc:D", "a.md", 1)],
    ["doc:D"],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "r1 deliberate new link to vacated path",
    [],
    [written("New", "a.md")],
    [shown("doc:D", "b.md", 2)],
    ["doc:D"],
    [{ pass: 3 }],
  ),
  fixture(
    "r2 swap, stale write deletes E occurrence",
    [old("D label", "doc:D", "c.md"), old("E label", "doc:E", "a.md")],
    [written("D renamed", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:E", "b.md", 1)],
    ["doc:D", "doc:E"],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "r2 intermediate spelling",
    [old("D label", "doc:D", "c.md")],
    [written("D renamed", "b.md")],
    [shown("doc:D", "b.md", 2)],
    ["doc:D"],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "r2 holder moved (written normalized against read-time holder)",
    [old("D label", "doc:D", "one/T.md")],
    [written("D renamed", "one/T.md")],
    [shown("doc:D", "one/T.md", 1)],
    ["doc:D"],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "r2 holder in user:// keeps identity (contextual form)",
    [old("D label", "doc:D", "manuscript://b.md")],
    [written("D renamed", "manuscript://b.md")],
    [],
    [],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "r3 earlier read, later unrelated partial read",
    [old("D label", "doc:D", "b.md")],
    [written("Changed words", "a.md")],
    [shown("doc:D", "a.md", 1)],
    ["doc:D"],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "r3 gone D and live E spelled alike, delete first",
    [old("Deleted D", "doc:D", "a.md", false), old("Live E", "doc:E", "a.md")],
    [written("Live E", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:E", "a.md", 1)],
    ["doc:E"],
    [{ pass: 1, occurrence: 1 }],
  ),
  fixture(
    "r4 live prefix capture on deleting first link",
    [old("Target retired", "doc:D", "b.md"), old("Target", "doc:E", "a.md")],
    [written("Target", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:D", "b.md", 2), shown("doc:E", "a.md", 2)],
    ["doc:D", "doc:E"],
    [{ pass: 1, occurrence: 1 }],
  ),
  fixture(
    "r4 gone prefix capture on deleting first link",
    [old("Target retired", "doc:D", "a.md", false), old("Target", "doc:E", "a.md")],
    [written("Target", "a.md")],
    [shown("doc:D", "a.md", 2), shown("doc:E", "a.md", 2)],
    ["doc:E"],
    [{ pass: 1, occurrence: 1 }],
  ),
  fixture(
    "r4 tie on whole replacement prefers live",
    [],
    [written("Anything", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:E", "a.md", 1)],
    ["doc:E"],
    [{ pass: 2, ref: "doc:E" }],
  ),
  fixture(
    "r4 union does not replay old address on a new link",
    [],
    [written("New", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:D", "b.md", 2)],
    ["doc:D"],
    [{ pass: 3 }],
  ),
  fixture(
    "deliberate retarget keeps label",
    [old("Target", "doc:D", "b.md")],
    [written("Target", "z.md")],
    [shown("doc:D", "b.md", 1)],
    ["doc:D"],
    [{ pass: 3 }],
  ),
  fixture(
    "#729 whole replacement current path",
    [old("Target", "doc:D", "new.md")],
    [written("Changed label", "new.md")],
    [shown("doc:D", "new.md", 1)],
    ["doc:D"],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "two links, model edits second label only",
    [old("Alpha", "doc:A", "a.md"), old("Beta", "doc:B", "b.md")],
    [written("Alpha", "a.md"), written("Beta prime", "b.md")],
    [shown("doc:A", "a.md", 1), shown("doc:B", "b.md", 1)],
    ["doc:A", "doc:B"],
    [
      { pass: 1, occurrence: 0 },
      { pass: 1, occurrence: 1 },
    ],
  ),
  fixture(
    "fresh contextual link stays contextual",
    [],
    [written("Notes", "scratch://notes.md")],
    [],
    [],
    [{ pass: 3 }],
  ),
  fixture(
    "r5 two-distinguishable-gone-live-occurrences-whole-label-replacement",
    [old("Retired", "doc:D", "a.md", false), old("Current", "doc:E", "a.md")],
    [written("X", "a.md"), written("Y", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:E", "a.md", 1)],
    ["doc:E"],
    [
      { pass: 1, occurrence: 0 },
      { pass: 1, occurrence: 1 },
    ],
  ),
  fixture(
    "r5 multi-whole-label-replacement-at-earlier-shown-addresses",
    [old("Alpha", "doc:D", "c.md"), old("Beta", "doc:E", "d.md")],
    [written("X", "a.md"), written("Y", "b.md")],
    [
      shown("doc:D", "a.md", 1),
      shown("doc:E", "b.md", 1),
      shown("doc:D", "c.md", 2),
      shown("doc:E", "d.md", 2),
    ],
    ["doc:D", "doc:E"],
    [
      { pass: 1, occurrence: 0 },
      { pass: 1, occurrence: 1 },
    ],
  ),
  fixture(
    "r5 whole-label-replacement-plus-delete-at-earlier-address",
    [old("Alpha", "doc:D", "c.md"), old("Beta", "doc:E", "d.md")],
    [written("X", "a.md")],
    [
      shown("doc:D", "a.md", 1),
      shown("doc:E", "b.md", 1),
      shown("doc:D", "c.md", 2),
      shown("doc:E", "d.md", 2),
    ],
    ["doc:D", "doc:E"],
    [{ pass: 1, occurrence: 0 }],
  ),
  fixture(
    "r5 delete-first-and-extend-survivor-historical-prefix-capture",
    [old("Target retired", "doc:D", "b.md"), old("Target", "doc:E", "a.md")],
    [written("Target expanded", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:D", "b.md", 2), shown("doc:E", "a.md", 2)],
    ["doc:D", "doc:E"],
    [{ pass: 1, occurrence: 1 }],
  ),
  fixture(
    "r5 same-label-swap-write-preserves-shown-addresses-in-reversed-order",
    [old("Target", "doc:D", "b.md"), old("Target", "doc:E", "a.md")],
    [written("Target", "b.md"), written("Target", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:E", "b.md", 1)],
    ["doc:D", "doc:E"],
    [
      { pass: 1, occurrence: 1 },
      { pass: 1, occurrence: 0 },
    ],
  ),
  fixture(
    "r6 control-in-order-earlier-addresses",
    [old("Alpha", "doc:D", "c.md"), old("Beta", "doc:E", "d.md")],
    [written("Alpha expanded", "a.md"), written("Beta expanded", "b.md")],
    [
      shown("doc:D", "a.md", 1),
      shown("doc:E", "b.md", 1),
      shown("doc:D", "c.md", 2),
      shown("doc:E", "d.md", 2),
    ],
    ["doc:D", "doc:E"],
    [
      { pass: 1, occurrence: 0 },
      { pass: 1, occurrence: 1 },
    ],
  ),
  fixture(
    "r6 reordered-earlier-addresses-whole-label-replacements",
    [old("Alpha", "doc:D", "c.md"), old("Beta", "doc:E", "d.md")],
    [written("Y", "b.md"), written("X", "a.md")],
    [
      shown("doc:D", "a.md", 1),
      shown("doc:E", "b.md", 1),
      shown("doc:D", "c.md", 2),
      shown("doc:E", "d.md", 2),
    ],
    ["doc:D", "doc:E"],
    [
      { pass: 1, occurrence: 1 },
      { pass: 1, occurrence: 0 },
    ],
  ),
  fixture(
    "r6 reordered-earlier-addresses-extended-labels",
    [old("Alpha", "doc:D", "c.md"), old("Beta", "doc:E", "d.md")],
    [written("Beta expanded", "b.md"), written("Alpha expanded", "a.md")],
    [
      shown("doc:D", "a.md", 1),
      shown("doc:E", "b.md", 1),
      shown("doc:D", "c.md", 2),
      shown("doc:E", "d.md", 2),
    ],
    ["doc:D", "doc:E"],
    [
      { pass: 1, occurrence: 1 },
      { pass: 1, occurrence: 0 },
    ],
  ),
  fixture(
    "r6 exact-survivor-excludes-uniquely-compatible-edited-link",
    [old("Alpha", "doc:D", "c.md"), old("Beta", "doc:E", "d.md")],
    [written("Beta expanded", "b.md"), written("Alpha", "c.md")],
    [
      shown("doc:D", "a.md", 1),
      shown("doc:E", "b.md", 1),
      shown("doc:D", "c.md", 2),
      shown("doc:E", "d.md", 2),
    ],
    ["doc:D", "doc:E"],
    [
      { pass: 1, occurrence: 1 },
      { pass: 1, occurrence: 0 },
    ],
  ),
  fixture(
    "r6 control-reordered-latest-addresses",
    [old("Alpha", "doc:D", "c.md"), old("Beta", "doc:E", "d.md")],
    [written("Beta expanded", "d.md"), written("Alpha expanded", "c.md")],
    [
      shown("doc:D", "a.md", 1),
      shown("doc:E", "b.md", 1),
      shown("doc:D", "c.md", 2),
      shown("doc:E", "d.md", 2),
    ],
    ["doc:D", "doc:E"],
    [
      { pass: 1, occurrence: 1 },
      { pass: 1, occurrence: 0 },
    ],
  ),
  fixture(
    "r6 model-weak-long-label-overrides-strong-address",
    [old(`${"x".repeat(901)} retired`, "doc:D", "b.md"), old("Target", "doc:E", "a.md")],
    [written(`${"x".repeat(901)} expanded`, "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:D", "b.md", 2), shown("doc:E", "a.md", 2)],
    ["doc:D", "doc:E"],
    [{ pass: 1, occurrence: 1 }],
  ),
  fixture(
    "r7 remaining tie prefers the earlier written occurrence",
    [old("Target", "doc:D", "c.md")],
    [written("Target", "a.md"), written("Target", "a.md")],
    [shown("doc:D", "a.md", 1), shown("doc:D", "c.md", 2)],
    ["doc:D"],
    [{ pass: 1, occurrence: 0 }, { pass: 3 }],
  ),
];
