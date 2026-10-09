/**
 * Shown-link facts (contract §7.1): for each link the model was shown, its
 * ref and the absolute address shown. Host-only; never in model text.
 *
 * Facts come from the render itself. A bound codec keeps a ledger of every
 * hashline it rendered: the immutable node, the hash and body it emitted, and
 * the address each ref-bearing occurrence spelled in that same scope. A
 * result's items are then looked up by the hash they carry, never by the
 * document's current state. A whole item counts all its ref-bearing
 * occurrences; a truncated one counts only those whose source span ends
 * inside the shown prefix. A claimed showing that was cut off could bind a
 * later link wrongly, while a missed one only weakens binding toward a fresh
 * resolve, so every doubt answers "not shown".
 */
import {
  type DocumentLinkScope,
  type ParsedContentWithSpans,
  type PMNode,
  type SpelledLinkFact,
  walkLinkOccurrences,
} from "@meridian/markup";
import type { ConcurrentEditInfo } from "../apply/types.js";
import type { AgentEditBlockItem, AgentEditModelPayload } from "../tool/model-result.js";
import { modelBlockItem } from "../tool/model-result.js";

export type { SpelledLinkFact };

/** What one bound codec rendered, and the links each rendered item showed. */
export interface ShownLinkLedger {
  /** Record a hashline render: `hashes[i]` and `bodies[i]` are what `blocks[i]` emitted. */
  record(blocks: readonly PMNode[], hashes: readonly string[], bodies: readonly string[]): void;
  /** Facts for items this codec rendered (whole or as a prefix); anything else records nothing. */
  shownLinks(items: readonly AgentEditBlockItem[]): SpelledLinkFact[];
}

interface Rendered {
  body: string;
  /** Index-aligned with the block's link occurrences; null when no ref or no address. */
  facts: (SpelledLinkFact | null)[];
  /** Source spans of the occurrences in `body`, parsed only when a prefix needs them. */
  spans?: ParsedContentWithSpans["spans"] | null;
}

export function createShownLinkLedger(
  scope: DocumentLinkScope,
  parser: { parseWithSpans(text: string): ParsedContentWithSpans },
): ShownLinkLedger {
  const byHash = new Map<string, Rendered[]>();

  const spansOf = (rendered: Rendered) => {
    if (rendered.spans === undefined) {
      try {
        const spans = parser.parseWithSpans(rendered.body).spans;
        // A reparse that disagrees with the block names no occurrence reliably.
        rendered.spans = spans.length === rendered.facts.length ? spans : null;
      } catch {
        rendered.spans = null;
      }
    }
    return rendered.spans;
  };

  const factsOf = (rendered: Rendered, shownLength: number): SpelledLinkFact[] => {
    const present = (fact: SpelledLinkFact | null): fact is SpelledLinkFact => fact !== null;
    if (shownLength >= rendered.body.length) return rendered.facts.filter(present);
    const spans = spansOf(rendered);
    if (!spans) return [];
    return rendered.facts.filter(
      (fact, index): fact is SpelledLinkFact =>
        fact !== null && (spans[index]?.end ?? Infinity) <= shownLength,
    );
  };

  return {
    record(blocks, hashes, bodies) {
      blocks.forEach((block, index) => {
        const hash = hashes[index];
        const body = bodies[index];
        if (hash === undefined || body === undefined) return;
        const occurrences = walkLinkOccurrences([block]);
        if (!occurrences.some((occurrence) => occurrence.attrs.ref !== null)) return;
        const facts = occurrences.map(({ kind, attrs }): SpelledLinkFact | null => {
          if (attrs.ref === null) return null;
          const { address } =
            kind === "link"
              ? scope.spellLink({ href: attrs.href, ref: attrs.ref })
              : scope.spellSource({ src: attrs.href, ref: attrs.ref });
          return address === null ? null : { ref: attrs.ref, address };
        });
        const entries = byHash.get(hash) ?? [];
        if (!entries.some((entry) => entry.body === body && sameFacts(entry.facts, facts)))
          entries.push({ body, facts });
        byHash.set(hash, entries);
      });
    },
    shownLinks(items) {
      const facts = new Map<string, SpelledLinkFact>();
      for (const item of items) {
        const shown = item.body.replace(/^\n/, "");
        const renders = (byHash.get(item.hash) ?? []).filter((entry) =>
          entry.body.startsWith(shown),
        );
        // The same text rendered from different states: only what every render showed counts.
        let common: Map<string, SpelledLinkFact> | undefined;
        for (const rendered of renders) {
          const keyed = new Map(factsOf(rendered, shown.length).map((fact) => [key(fact), fact]));
          common = common ? new Map([...common].filter(([factKey]) => keyed.has(factKey))) : keyed;
        }
        for (const [factKey, fact] of common ?? []) facts.set(factKey, fact);
      }
      return [...facts.values()];
    },
  };
}

function key(fact: SpelledLinkFact): string {
  return `${fact.ref}\u0000${fact.address}`;
}

function sameFacts(left: readonly (SpelledLinkFact | null)[], right: typeof left): boolean {
  const spell = (facts: typeof left) => facts.map((fact) => (fact ? key(fact) : "")).join("\u0001");
  return spell(left) === spell(right);
}

/** Every block item a model payload renders: block groups and concurrent runs. */
export function renderedItems(payload: AgentEditModelPayload | undefined): AgentEditBlockItem[] {
  if (!payload) return [];
  return [
    ...(payload.blocks ?? []).flatMap((group) => group.items),
    ...(payload.concurrent?.runs ?? []).flatMap((run) => run.blocks),
  ];
}

/**
 * Each concurrent run carries its own facts: the request assembler may drop
 * runs to fit its budget, and a dropped run was never shown.
 */
export function withRunShownLinks(
  info: ConcurrentEditInfo | undefined,
  ledger: Pick<ShownLinkLedger, "shownLinks">,
): ConcurrentEditInfo | undefined {
  if (!info) return info;
  return {
    ...info,
    runs: info.runs.map((run) => {
      const shownLinks = ledger.shownLinks(run.blocks.map(modelBlockItem));
      return shownLinks.length > 0 ? { ...run, shownLinks } : run;
    }),
  };
}
