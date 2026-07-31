/**
 * Where `@` opens the reference menu — the whole envelope, as one predicate.
 *
 * `@` is an ordinary character of prose in a way `[[` is not. Two brackets are
 * already an unambiguous request; a lone `@` is a preposition ("meet @ noon"),
 * half an address (`ilsever@thepale.example`), and a handle a writer is quoting.
 * So this lane takes the shared reference envelope — prose only, never a code
 * fence, never inside a link the writer is correcting — and adds back the word
 * boundary `/` also demands: an `@` typed against a letter is part of a word,
 * and no menu opens over it.
 *
 * The boundary is what makes email addresses safe, and it is the only rule that
 * can be: the address's `@` always follows a letter, while a writer naming a
 * chapter always types `@` at the start of one.
 */

import type { Node as PMNode } from "@tiptap/pm/model";

import { allowsProseTrigger, atWordBoundary } from "../suggestion";

/**
 * `from` is the position of the `@` itself, which is what
 * `@tiptap/suggestion` hands its `allow` predicate as `range.from`.
 */
export function allowsAtTrigger(doc: PMNode, from: number): boolean {
  return allowsProseTrigger(doc, from) && atWordBoundary(doc, from);
}
