/**
 * Late-peer recovery (spec-content-rebase "Late peers"). A writer types into a top-level block that a
 * rebase, a peer or the model deletes or retypes before the writer has seen it; Yjs merges that into dead
 * state (`late-peer.ts` detects it), whichever arrives first, the typing or the deletion. A stale
 * typist is not current intent, so on text another change removed it contributes only its net surviving
 * typing, and nothing else. What the typist sees is its own frame's delete set when the typing arrives
 * second, and the document before the deletion when the deletion does:
 *
 * - The typing the peer still shows is written into the draft beside its block's last known neighbour,
 *   one paragraph per typed span: characters the peer typed with nothing it still sees between them,
 *   whatever Yjs items or frames they came in. Inner whitespace stays; only the paragraph's outer edges
 *   are trimmed. Spans with surviving other text between them stay apart, so two typed words never fuse.
 *   Green in review, the writer decides. The words the rebase replaced are never revived around it.
 * - The frame's deletions never apply (log-only), including deletions of typing recovered from earlier
 *   frames: a reconnect resends the peer's whole delete set, and once the peer has received the server's
 *   state that set holds the recovered characters too (they sit in the block the rebase deleted). Nothing
 *   tells that echo from a backspace, so acting on it would erase writing. A backspace the peer typed into
 *   recovered text before it caught up survives; the writer deletes it again.
 *
 * A browser reconnect can resend its offline typing one keystroke per frame. `LateTyping` carries the
 * spans already written from earlier frames, so the next keystroke extends its span's paragraph instead
 * of starting another, edited in place so the characters a peer saw keep their ids. A remembered paragraph the draft no longer shows exactly as written (the writer
 * edited, formatted or removed it: text, marks and attributes all count) is settled: it is never touched
 * again, and new typing beside it starts its own.
 *
 * Pure: it needs the doc with the update applied, the update, and the memory from earlier frames.
 */
import { newBlockId } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { blocksEqual } from "./equal.js";
import { readBlocks } from "./fragments.js";
import type { LostEdits } from "./late-peer.js";
import { writeBlocks } from "./writer.js";

/** A typed span already written into the draft from an earlier frame. */
interface WrittenSpan {
  /** The dead top-level block the span was typed in. */
  readonly block: string;
  /** The typed characters, in order (`client:clock`). */
  readonly ids: readonly string[];
  /** The paragraph written for it, as written (null when the span was only whitespace and wrote nothing). */
  readonly written: PMNode | null;
  /** The paragraph element written, or null when nothing was. */
  readonly paragraph: Y.ID | null;
}

/** What earlier frames on the same draft recovered; opaque to callers, who keep the latest per draft. */
export interface LateTyping {
  readonly spans: readonly WrittenSpan[];
  /** Characters of dead blocks the peer deleted in earlier frames, other than typing written before. */
  readonly deleted: ReadonlySet<string>;
}

export const NO_LATE_TYPING: LateTyping = { spans: [], deleted: new Set() };

/** Entries kept per draft; past this the memory starts over (later typing may then start new paragraphs). */
const MEMORY_LIMIT = 50_000;

export interface LateRecovery {
  /** The server-peer update that writes the typing, or null when nothing needed writing. */
  update: Uint8Array | null;
  /** Each paragraph of the peer's typing written or rewritten into the draft. */
  written: string[];
  /** Characters of dead text the frame deleted, which stay as they are (log-only). */
  dropped: number;
  /** The memory to pass with the next frame on this draft, once this one is persisted. */
  memory: LateTyping;
}

/** Keep separator deletions observed while a host's append awaited I/O, without replacing
 * its newly recovered spans. Remembered typing still wins over stale backspaces. */
export function retainLateTypingDeletions(memory: LateTyping, observed: LateTyping): LateTyping {
  if (memory === observed || !observed.deleted.size) return memory;
  const remembered = new Set(memory.spans.flatMap((span) => span.ids));
  const deleted = new Set(memory.deleted);
  for (const id of observed.deleted) if (!remembered.has(id)) deleted.add(id);
  const size = deleted.size + memory.spans.reduce((n, span) => n + span.ids.length, 0);
  return size > MEMORY_LIMIT ? NO_LATE_TYPING : { spans: memory.spans, deleted };
}

const LATE_PEER_ORIGIN = "late-peer";
const keyOf = (id: Y.ID) => `${id.client}:${id.clock}`;
const elementOf = (item: Y.Item) => (item.content as Y.ContentType).type as Y.XmlElement;

/** The top-level block (a child of `fragment`) an item sits in, if the doc still knows it. */
function topLevelBlock(doc: Y.Doc, fragment: Y.XmlFragment, id: Y.ID): Y.Item | null {
  let item: Y.Item | Y.GC | null = Y.getItem(doc.store, id);
  while (item instanceof Y.Item) {
    const parent = item.parent as Y.AbstractType<unknown>;
    if (parent === fragment) return item;
    item = parent._item;
  }
  return null;
}

interface Span {
  ids: string[];
  text: string;
}

/**
 * The typed spans inside `block` as the peer sees it, in document order: typed characters with nothing
 * the peer still sees between them (deleted characters are skipped) form one span.
 */
function typedSpans(
  block: Y.XmlElement,
  typed: (key: string) => boolean,
  peerDeleted: (id: Y.ID) => boolean,
): Span[] {
  const spans: Span[] = [];
  let open: Span | null = null;
  const visit = (type: Y.AbstractType<unknown>) => {
    for (let item = type._start; item; item = item.right) {
      if (item.content instanceof Y.ContentType) {
        if (!peerDeleted(item.id)) open = null;
        visit(item.content.type as Y.AbstractType<unknown>);
        continue;
      }
      if (item.content instanceof Y.ContentFormat) continue;
      const str = item.content instanceof Y.ContentString ? item.content.str : null;
      for (let i = 0; i < item.length; i++) {
        const id = Y.createID(item.id.client, item.id.clock + i);
        const key = keyOf(id);
        // Typing the detector accepted stays typing: its delete-set entry was explained by its block,
        // and judging it again from the same set would drop it.
        if (str && typed(key)) {
          if (!open) {
            open = { ids: [], text: "" };
            spans.push(open);
          }
          open.ids.push(key);
          open.text += str[i];
        } else if (!peerDeleted(id)) open = null;
      }
    }
  };
  visit(block as unknown as Y.AbstractType<unknown>);
  return spans;
}

/**
 * Writes what the late-peer `update` lost into `doc` (the clone the caller will persist, with the update
 * already applied). `lost` is `findLostEdits` run before the apply; `memory` is what the previous frame on
 * this draft returned; `clientId` is the server-peer client the write uses.
 */
export function recoverLatePeerEdits(input: {
  doc: Y.Doc;
  update: Uint8Array;
  lost: LostEdits;
  memory?: LateTyping;
  schema: Schema;
  fragmentName: string;
  clientId: number;
}): LateRecovery {
  const { doc, schema } = input;
  const memory = input.memory ?? NO_LATE_TYPING;
  // Typing written before is never deleted again: its deletions are left out of the peer's view.
  const remembered = new Set(memory.spans.flatMap((s) => s.ids));
  const deleted = new Set(memory.deleted);
  for (const { id } of input.lost.deleted) if (!remembered.has(keyOf(id))) deleted.add(keyOf(id));
  const out: LateRecovery = {
    update: null,
    written: [],
    dropped: input.lost.deleted.length,
    memory,
  };

  const frameTyped = new Set<string>();
  for (const { id, text } of input.lost.typed)
    for (let i = 0; i < text.length; i++) frameTyped.add(`${id.client}:${id.clock + i}`);
  const touched = input.lost.typed.map((e) => e.id);
  if (!touched.length) return finish(out, [...memory.spans], deleted);

  const fragment = doc.getXmlFragment(input.fragmentName);
  const elements = fragment.toArray();
  const current = readBlocks(fragment, schema);
  // Block indexes only line up when every element read back as a block; otherwise the words go last
  // and nothing is remembered, since no paragraph can be found again.
  const aligned = current.length === elements.length;
  const { ds } = Y.decodeUpdate(input.update);
  // What the typist sees deleted: its frame's delete set, or when a delete arrives after the typing
  // (`removed`), the document before that frame, since the frame's delete set is the deleter's.
  const peerDeleted = (id: Y.ID) =>
    !remembered.has(keyOf(id)) && (Y.isDeleted(ds, id) || deleted.has(keyOf(id)));
  const documentDeleted = (id: Y.ID) =>
    !remembered.has(keyOf(id)) && input.lost.invisible.has(keyOf(id));
  const afterDelete = new Set<string>();

  /** Beside its last known neighbour: after the block itself if it stands, else after the nearest survivor before it. */
  const anchorOf = (item: Y.Item) => {
    if (!item.deleted) return elements.indexOf(elementOf(item));
    for (let left = item.left; left; left = left.left)
      if (!left.deleted) return elements.indexOf(elementOf(left));
    return -1;
  };
  /** The index of a remembered paragraph, when the draft still shows it exactly as written. */
  const shownAt = (span: WrittenSpan): number | null => {
    if (!span.paragraph || !span.written) return null;
    const item = Y.getItem(doc.store, span.paragraph) as Y.Item | Y.GC;
    if (!(item instanceof Y.Item) || item.deleted || item.parent !== fragment) return null;
    const at = elements.indexOf(elementOf(item));
    return at >= 0 && current[at] && blocksEqual([current[at]], [span.written]) ? at : null;
  };

  const para = (text: string, id = newBlockId()) =>
    schema.nodes.paragraph.create({ id }, schema.text(text));
  interface Pending {
    text: string;
    span: Omit<WrittenSpan, "paragraph"> | null;
  }
  const insertAfter = new Map<number, Pending[]>(); // anchor index (-1 = the start) -> paragraphs
  const rewrite = new Map<number, Pending>(); // index -> new text ("" removes the paragraph)
  const extend = new Map<number, { span: Span; oldIds: readonly string[] }>(); // index -> a shown paragraph edited in place
  const kept: WrittenSpan[] = [];
  const add = (anchor: number, pending: Pending) => {
    if (pending.text) out.written.push(pending.text);
    insertAfter.set(anchor, [...(insertAfter.get(anchor) ?? []), pending]);
  };

  const blocks = new Map<string, Y.Item>();
  for (const id of touched) {
    const item = topLevelBlock(doc, fragment, id);
    if (item) {
      blocks.set(keyOf(item.id), item);
      if (input.lost.typed.find((e) => e.id === id)?.removed) afterDelete.add(keyOf(item.id));
    } else {
      const text = input.lost.typed.find((e) => e.id === id)?.text.trim();
      if (text) add(-1, { text, span: null });
    }
  }
  for (const span of memory.spans) if (!blocks.has(span.block)) kept.push(span);

  for (const [block, item] of blocks) {
    // Spans written before that the draft still shows as written; the rest are settled.
    const live = aligned
      ? memory.spans.filter((s) => s.block === block && (!s.paragraph || shownAt(s) !== null))
      : [];
    const liveIds = new Set(live.flatMap((s) => s.ids));
    const claimed = new Set<WrittenSpan>();
    for (const span of typedSpans(
      elementOf(item),
      (key) => frameTyped.has(key) || liveIds.has(key),
      afterDelete.has(block) ? documentDeleted : peerDeleted,
    )) {
      const text = span.text.trim();
      const ids = new Set(span.ids);
      const matches = live.filter((s) => !claimed.has(s) && s.ids.some((id) => ids.has(id)));
      for (const s of matches) claimed.add(s);
      // Remembered typing is never deleted, so a span holding a written paragraph's typing still has text.
      const published = matches.filter((s) => s.paragraph);
      /** One run of typing as one paragraph: `home` is the published paragraph it extends, if any. */
      const place = (run: Span, home: WrittenSpan | undefined) => {
        const runText = run.text.trim();
        const next = aligned
          ? {
              block,
              ids: run.ids,
              written: runText ? para(runText, home?.written?.attrs.id) : null,
            }
          : null;
        if (home) {
          if (runText !== home.written?.textContent) {
            out.written.push(runText);
            rewrite.set(shownAt(home) as number, { text: runText, span: next });
            extend.set(shownAt(home) as number, { span: run, oldIds: home.ids });
          } else if (next) kept.push({ ...home, ids: next.ids });
        } else if (runText) add(anchorOf(item), { text: runText, span: next });
        else if (next) kept.push({ ...next, paragraph: null });
      };
      if (published.length <= 1) {
        place(span, published[0]);
        continue;
      }
      // The peer removed what stood between paragraphs already shown. Each stays its own paragraph, since
      // copying one into another would give its words new ids and a peer that saw them would not list
      // them. New characters join the paragraph before them, or the one after, in place.
      const owner = new Map<string, WrittenSpan>();
      for (const s of published) for (const id of s.ids) owner.set(id, s);
      const segments: Array<{ owner: WrittenSpan | undefined; from: number; to: number }> = [];
      for (let at = 0; at < span.ids.length; at++) {
        const who = owner.get(span.ids[at]);
        const last = segments[segments.length - 1];
        if (last && last.owner === who) last.to = at + 1;
        else segments.push({ owner: who, from: at, to: at + 1 });
      }
      const claims = new Map<WrittenSpan | undefined, Span>();
      segments.forEach((seg, i) => {
        const to = seg.owner ?? segments[i - 1]?.owner ?? segments[i + 1]?.owner;
        const into = claims.get(to) ?? { ids: [], text: "" };
        into.ids.push(...span.ids.slice(seg.from, seg.to));
        into.text += span.text.slice(seg.from, seg.to);
        claims.set(to, into);
      });
      for (const [home, run] of claims) place(run, home);
    }
  }

  if (!insertAfter.size && !rewrite.size) return finish(out, kept, deleted);

  const target: PMNode[] = [];
  const placed: Array<[number, Omit<WrittenSpan, "paragraph">]> = [];
  /** A rewritten paragraph keeps the id of the one it replaces. */
  const push = (pending: Pending, id?: string) => {
    const written = pending.span?.written;
    const node = written
      ? written.type.create({ ...written.attrs, id: id ?? written.attrs.id }, written.content)
      : para(pending.text, id);
    if (pending.span) placed.push([target.length, { ...pending.span, written: node }]);
    target.push(node);
  };
  for (const pending of insertAfter.get(-1) ?? []) push(pending);
  current.forEach((block, i) => {
    const change = rewrite.get(i);
    if (!change) target.push(block);
    else if (change.text) {
      // The paragraph stays as it is here and is edited below, so the characters a peer saw keep their ids.
      if (change.span) placed.push([target.length, change.span]);
      target.push(block);
    }
    if (aligned) for (const pending of insertAfter.get(i) ?? []) push(pending);
  });
  if (!aligned)
    for (const [anchor, added] of insertAfter) if (anchor >= 0) for (const p of added) push(p);
  doc.clientID = input.clientId;
  // Only this transaction's update: `encodeStateAsUpdate` always carries the whole delete set,
  // which holds the binding's repair of an element the schema cannot build (`readBlocks` above).
  // That repair is schema repair's to journal, never the recovery's.
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LATE_PEER_ORIGIN) out.update = update;
  };
  doc.on("update", onUpdate);
  try {
    doc.transact(() => {
      writeBlocks(fragment, schema, target);
      for (const [i, { span, oldIds }] of extend)
        extendParagraph(elements[i] as Y.XmlElement, oldIds, span);
    }, LATE_PEER_ORIGIN);
  } finally {
    doc.off("update", onUpdate);
  }
  const after = fragment.toArray();
  if (after.length === target.length)
    for (const [at, span] of placed) {
      const id = (after[at] as Y.XmlElement)._item?.id;
      if (id) kept.push({ ...span, paragraph: id });
    }
  return finish(out, kept, deleted);
}

/**
 * Edits a recovered paragraph into the typist's span by inserting only the characters it does not hold,
 * each where the typist placed it among the ones it does (their ids give the order). A text diff would
 * choose its own alignment and replace words, and a peer that saw the old characters and deletes the
 * paragraph would then not list the new ones.
 */
function extendParagraph(paragraph: Y.XmlElement, oldIds: readonly string[], span: Span) {
  const text = paragraph.firstChild;
  if (!(text instanceof Y.XmlText)) return;
  const charOf = new Map(span.ids.map((key, i) => [key, span.text[i]]));
  const trimmed = (ids: readonly string[]) => {
    let lo = 0;
    let hi = ids.length;
    while (lo < hi && /\s/.test(charOf.get(ids[lo]) ?? "x")) lo++;
    while (hi > lo && /\s/.test(charOf.get(ids[hi - 1]) ?? "x")) hi--;
    return ids.slice(lo, hi);
  };
  const held = trimmed(oldIds);
  const heldAt = new Map(held.map((key, i) => [key, i]));
  let pos = 0;
  let passed = 0;
  for (const key of trimmed(span.ids)) {
    const at = heldAt.get(key);
    if (at === undefined || at < passed) {
      text.insert(pos, charOf.get(key) as string);
    } else {
      if (at > passed) text.delete(pos, at - passed);
      passed = at + 1;
    }
    pos++;
  }
  if (passed < held.length) text.delete(pos, held.length - passed);
}

function finish(out: LateRecovery, spans: WrittenSpan[], deleted: Set<string>): LateRecovery {
  const size = deleted.size + spans.reduce((n, s) => n + s.ids.length, 0);
  out.memory = size > MEMORY_LIMIT ? NO_LATE_TYPING : { spans, deleted };
  return out;
}
