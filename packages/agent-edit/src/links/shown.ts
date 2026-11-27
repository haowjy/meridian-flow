import type { LinkView } from "@meridian/contracts";
import type { DocumentLinkScope, ParsedContentWithSpans, PMNode } from "@meridian/markup";
import { type SpelledLinkFact, spelledFact, walkLinkOccurrences } from "@meridian/markup/links";
import type { AgentEditBlockItem, AgentEditModelPayload } from "../tool/model-result.js";

export type { SpelledLinkFact };

export interface ShownLinkLedger {
  record(blocks: readonly PMNode[], hashes: readonly string[], bodies: readonly string[]): void;
  shownLinks(items: readonly AgentEditBlockItem[]): SpelledLinkFact[];
}

interface Rendered {
  body: string;
  facts: (SpelledLinkFact | null)[];
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
        if (occurrences.length === 0) return;
        const facts = occurrences.map((occurrence) => spelledFact(occurrence, scope));
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

export interface LinkShowing {
  holderUri: string;
  view: LinkView;
  links: readonly SpelledLinkFact[];
}

interface ShownCommandLinks {
  codec: Pick<ShownLinkLedger, "shownLinks">;
  scope: { holder: { uri: string | null; view: LinkView } };
}

export function shownEvidence(
  items: readonly AgentEditBlockItem[],
  links: ShownCommandLinks,
): { showing?: LinkShowing } {
  const { uri, view } = links.scope.holder;
  if (uri === null) return {};
  const shown = links.codec.shownLinks(items);
  return shown.length > 0 ? { showing: { holderUri: uri, view, links: shown } } : {};
}

export function renderedItems(payload: AgentEditModelPayload | undefined): AgentEditBlockItem[] {
  if (!payload) return [];
  return (payload.blocks ?? []).flatMap((group) => group.items);
}
