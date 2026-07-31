/**
 * Where `/` opens the menu — the whole envelope, as one pure predicate.
 *
 * The old slash menu's failure (F6) was not a bad rule but an undefined one:
 * the trigger was gated on preconditions nobody had written down, so a writer
 * who typed `/` and got a literal slash had no way to learn why. This function
 * IS the contract (§5.7), and `slash-trigger.test.ts` is its truth table:
 *
 * - opens at the start of a text block, or immediately after whitespace
 * - in paragraphs (empty or not), headings, list items, quote paragraphs, and
 *   table cells, all of which are one of two node types once resolved
 * - never mid-word, never inside a code fence (which is also the diagram's
 *   source), and nowhere else is denied
 *
 * Both halves are the shared envelope's, and deliberately: the day a new block
 * becomes prose, or the day "mid-word" learns about a new inline node, `/` and
 * `@` have to change together or one of them is wrong.
 *
 * Everything the trigger needs is in the document, so nothing here reads the
 * editor, the catalog, or the view. A caller that wants "and the catalog is
 * live" composes that itself.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

import { atWordBoundary, inProseBlock } from "../suggestion";

/**
 * `from` is the position of the `/` itself, which is what
 * `@tiptap/suggestion` hands its `allow` predicate as `range.from`.
 *
 * A `/` inside a link is deliberately not refused the way a reference trigger
 * refuses one: `/` replaces the block it is typed in rather than writing a
 * destination, so an existing link says nothing about whether the writer meant
 * it.
 */
export function allowsSlashTrigger(doc: PMNode, from: number): boolean {
  return inProseBlock(doc, from) && atWordBoundary(doc, from);
}
