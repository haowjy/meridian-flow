import * as buf from "lib0/buffer";
import * as sha256 from "lib0/hash/sha256";
import type { Mark } from "prosemirror-model";

/**
 * The Yjs text attribute a mark is stored under, as the binding (`@tiptap/y-tiptap`
 * `marksToAttributes`) writes it: the bare name for a mark that excludes its own type, else
 * `name--<hash of mark.toJSON()>`, so two marks of one type with different attributes both stay.
 * A server writer that keys a mark any other way overwrites another Work's mark on the same text.
 */
export function yjsMarkKey(mark: Mark): string {
  if (mark.type.excludes(mark.type)) return mark.type.name;
  return `${mark.type.name}--${hashOfJSON(mark.toJSON())}`;
}

/** The mark name a stored text attribute key names: the inverse of `yjsMarkKey`'s prefix. */
export function markNameOfYjsKey(key: string): string {
  const match = /^(.*)--[a-zA-Z0-9+/=]{8}$/.exec(key);
  return match ? match[1] : key;
}

function hashOfJSON(json: unknown): string {
  const digest = sha256.digest(buf.encodeAny(json));
  for (let i = 6; i < digest.length; i++) digest[i % 6] = digest[i % 6] ^ digest[i];
  return buf.toBase64(digest.slice(0, 6));
}
