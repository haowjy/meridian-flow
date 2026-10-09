/**
 * Shown-link facts (contract §7.1): for each link the model was shown, its
 * ref and the absolute address shown. Host-only; never in model text.
 *
 * Facts come from what was actually rendered. A whole block counts all its
 * ref-bearing occurrences; a truncated block counts only those whose source
 * span ends inside the shown prefix. A claimed showing that was cut off could
 * bind a later link wrongly, while a missed one only weakens binding toward a
 * fresh resolve, so every doubt answers "not shown".
 */
import {
  type LinkOccurrence,
  type ParsedContentWithSpans,
  type PMNode,
  type SpelledLinkFact,
  walkLinkOccurrences,
} from "@meridian/markup";
import type { ConcurrentEditInfo } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { DocHandle } from "../handles.js";
import type { HolderLinkScope } from "../ports/document-links.js";
import type { AgentEditModel } from "../ports/model.js";
import type { AgentEditBlockItem, AgentEditModelPayload } from "../tool/model-result.js";
import { modelBlockItem } from "../tool/model-result.js";

export type { SpelledLinkFact };

/** Facts for one rendered block: all of them when shown whole, or those ending inside a prefix. */
export function shownLinkFacts(input: {
  block: PMNode;
  /** The block's full serialized body (no hashline prefix). */
  body: string;
  /** `body.length` when shown whole. */
  shownLength: number;
  scope: HolderLinkScope;
  codec: { parseWithSpans(text: string): ParsedContentWithSpans };
}): SpelledLinkFact[] {
  const occurrences = walkLinkOccurrences([input.block]);
  if (!occurrences.some((occurrence) => occurrence.attrs.ref !== null)) return [];
  if (input.shownLength >= input.body.length) return spell(occurrences, input.scope);
  let spans: ParsedContentWithSpans["spans"];
  try {
    spans = input.codec.parseWithSpans(input.body).spans;
  } catch {
    return [];
  }
  // A reparse that disagrees with the block names no occurrence reliably.
  if (spans.length !== occurrences.length) return [];
  return spell(
    occurrences.filter((_, index) => (spans[index]?.end ?? Infinity) <= input.shownLength),
    input.scope,
  );
}

function spell(occurrences: readonly LinkOccurrence[], scope: HolderLinkScope): SpelledLinkFact[] {
  const facts: SpelledLinkFact[] = [];
  for (const { kind, attrs } of occurrences) {
    if (attrs.ref === null) continue;
    const { address } =
      kind === "link"
        ? scope.spellLink({ href: attrs.href, ref: attrs.ref })
        : scope.spellSource({ src: attrs.href, ref: attrs.ref });
    if (address !== null) facts.push({ ref: attrs.ref, address });
  }
  return facts;
}

/** The document a render came from, and the binding it was spelled with. */
export interface ShownRenderSource {
  doc: DocHandle;
  model: AgentEditModel;
  codec: AgentEditCodec;
  scope: HolderLinkScope;
  parser: { parseWithSpans(text: string): ParsedContentWithSpans };
}

/**
 * Facts for rendered `hash|body` items, each matched to its block in `doc`
 * by hash. An item whose block is gone, or whose text is neither the block's
 * whole body nor a prefix of it (a concurrent render of another state, a
 * swept deletion), records nothing.
 */
export function shownLinksForItems(
  items: readonly AgentEditBlockItem[],
  source: ShownRenderSource,
): SpelledLinkFact[] {
  if (items.length === 0) return [];
  const blocks = source.model.getBlocks(source.doc);
  const nodes = source.model.projectBlocks(source.doc);
  const byHash = new Map<string, PMNode>();
  blocks.forEach((block, index) => {
    const node = nodes[index];
    if (node) byHash.set(source.model.getBlockId(block), node);
  });
  const facts = new Map<string, SpelledLinkFact>();
  for (const item of items) {
    const block = byHash.get(item.hash);
    if (!block) continue;
    const body = source.codec.serializeBlockBodies([block])[0] ?? "";
    const shown = item.body.replace(/^\n/, "");
    if (!body.startsWith(shown)) continue;
    for (const fact of shownLinkFacts({
      block,
      body,
      shownLength: shown.length,
      scope: source.scope,
      codec: source.parser,
    })) {
      facts.set(`${fact.ref}\u0000${fact.address}`, fact);
    }
  }
  return [...facts.values()];
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
  source: ShownRenderSource,
): ConcurrentEditInfo | undefined {
  if (!info) return info;
  return {
    ...info,
    runs: info.runs.map((run) => {
      const shownLinks = shownLinksForItems(run.blocks.map(modelBlockItem), source);
      return shownLinks.length > 0 ? { ...run, shownLinks } : run;
    }),
  };
}
