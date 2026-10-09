/**
 * Shown-link facts (contract §7.1): for each link or picture the model was
 * shown, its identity (a ref, or an upload's `asset:<id>`) and the absolute
 * address shown. Host-only; never in model text.
 *
 * Facts come from the render itself. A scoped codec keeps a ledger of every
 * link-bearing hashline it rendered: the hash and body it emitted, and the
 * address each identity-bearing occurrence spelled in that same scope; a render
 * with no refs is kept too, so equal text shown without them claims nothing. A
 * result's items are then looked up by the hash they carry, never by the
 * document's current state. A whole item counts all its identity-bearing
 * occurrences; a truncated one counts only those whose source span ends
 * inside the shown prefix. A claimed showing that was cut off could assign a
 * later link wrongly, while a missed one only weakens assignment toward a fresh
 * resolve, so every doubt answers "not shown".
 */
import type { LinkView } from "@meridian/contracts";
import type { DocumentLinkScope, ParsedContentWithSpans, PMNode } from "@meridian/markup";
import { type SpelledLinkFact, spelledFact, walkLinkOccurrences } from "@meridian/markup/links";
import type { ConcurrentEditInfo } from "../apply/types.js";
import type { AgentEditBlockItem, AgentEditModelPayload } from "../tool/model-result.js";
import { modelBlockItem } from "../tool/model-result.js";

export type { SpelledLinkFact };

/** What one scoped codec rendered, and the links each rendered item showed. */
export interface ShownLinkLedger {
  /** Record a hashline render: `hashes[i]` and `bodies[i]` are what `blocks[i]` emitted. */
  record(blocks: readonly PMNode[], hashes: readonly string[], bodies: readonly string[]): void;
  /** Facts for items this codec rendered (whole or as a prefix); anything else records nothing. */
  shownLinks(items: readonly AgentEditBlockItem[]): SpelledLinkFact[];
}

interface Rendered {
  body: string;
  /** Index-aligned with the block's link occurrences; null when no identity or no address. */
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
        // A render of links without identities is kept: it is the negative evidence
        // that clears a fact an equal-text render once showed.
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

/**
 * What one render showed the model in one holder: the facts its codec spelled,
 * and the holder URI and view it spelled them from. All three come from the
 * command links that rendered, so a holder moving after the render cannot lend
 * the facts another base. Host-only; never in model text.
 */
export interface LinkShowing {
  holderUri: string;
  view: LinkView;
  links: readonly SpelledLinkFact[];
}

/** A command's links as evidence needs them: the codec that rendered, and the holder it spelled for. */
export interface ShownCommandLinks {
  codec: Pick<ShownLinkLedger, "shownLinks">;
  scope: { holder: { uri: string | null; view: LinkView } };
}

/**
 * Host-only evidence for rendered items, from the command links that rendered them.
 * Empty when nothing identity-bearing was shown, or when those links spelled for no
 * holder (relative spellings then have no base to claim).
 */
export function shownEvidence(
  items: readonly AgentEditBlockItem[],
  links: ShownCommandLinks,
): { showing?: LinkShowing } {
  const { uri, view } = links.scope.holder;
  if (uri === null) return {};
  const shown = links.codec.shownLinks(items);
  return shown.length > 0 ? { showing: { holderUri: uri, view, links: shown } } : {};
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
  links: ShownCommandLinks,
): ConcurrentEditInfo | undefined {
  if (!info) return info;
  return {
    ...info,
    runs: info.runs.map((run) => ({
      ...run,
      ...shownEvidence(run.blocks.map(modelBlockItem), links),
    })),
  };
}
