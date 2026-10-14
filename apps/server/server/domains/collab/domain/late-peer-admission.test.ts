/**
 * Writer admission of stale peers (D33), as one seeded property: a peer forks, goes offline (browser
 * default GC, a real Undo manager), edits, and reconnects with `encodeStateAsUpdate(peer, serverSV)`
 * while rebases and another writer change the draft. The real coordinator admits every frame against an
 * instance-owned in-memory store.
 */
import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import { buildDocumentSchema, COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  type BranchSnapshot,
  type BranchStore,
  createBranchCoordinator,
} from "./branch-coordinator.js";

const schema = buildDocumentSchema();
const FRAG = "prosemirror";
const BRANCH = "draft-branch";
const para = (text: string) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const textsOf = (doc: Y.Doc) =>
  readBlocks(doc.getXmlFragment(FRAG), schema).map((b) => b.textContent);
/**
 * The words of `texts`. Concurrent character edits in text the rebase kept may fuse two generated words
 * (`l023b005`); fixed-width tokens split back apart, so the invariants judge words, not fusions.
 */
const tokensOf = (texts: readonly string[]) =>
  texts
    .join(" ")
    .split(/\s+/u)
    .filter(Boolean)
    .flatMap((w) => (/^(?:[a-z]\d{3})+$/u.test(w) ? (w.match(/[a-z]\d{3}/gu) ?? []) : [w]));
const countIn = (text: string, token: string) => text.split(token).length - 1;

/** mulberry32: a fixed seed replays the same history. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), chance: (p: number) => next() < p };
}

/** The word spans of a text: [start, end) per word. */
const spans = (text: string) =>
  [...text.matchAll(/\S+/gu)].map((m) => [m.index, m.index + m[0].length]);

/** Inserts `token` as its own word before word `at` (or after the last), keeping a space between words. */
function insertWord(text: Y.XmlText, at: number, token: string) {
  const s = spans(text.toString());
  if (!s.length) text.insert(0, token);
  else if (at < s.length) text.insert(s[at][0], `${token} `);
  else text.insert(s[s.length - 1][1], ` ${token}`);
}

/** Deletes word `at` with one adjoining space; a paragraph keeps its last word. */
function deleteWord(text: Y.XmlText, at: number): boolean {
  const s = spans(text.toString());
  if (s.length < 2) return false;
  const [from, to] = s[at % s.length];
  if (at % s.length === 0) text.delete(from, s[1][0] - from);
  else text.delete(s[(at % s.length) - 1][1], to - s[(at % s.length) - 1][1]);
  return true;
}

const xmlTexts = (doc: Y.Doc) =>
  doc
    .getXmlFragment(FRAG)
    .toArray()
    .map((el) => (el instanceof Y.XmlElement ? el.get(0) : null))
    .filter((t): t is Y.XmlText => t instanceof Y.XmlText && t.length > 0);

/** One draft, its coordinator, one stale peer and the invariants checked at every peer admission. */
function world(base: readonly string[]) {
  const seed = new Y.Doc({ gc: false });
  seed.clientID = 1;
  seed.transact(() => writeBlocks(seed.getXmlFragment(FRAG), schema, base.map(para)));
  let state = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const snapshot = (): BranchSnapshot => ({
    branchId: BRANCH,
    documentId: "00000000-0000-4000-8000-000000000601" as BranchSnapshot["documentId"],
    kind: "work_draft",
    status: "active",
    upstreamBranchId: null,
    draftId: "draft" as BranchSnapshot["draftId"],
    workId: null,
    threadId: null,
    state,
    stateVector: Y.encodeStateVectorFromUpdate(state),
    schemaVersion: COLLAB_SCHEMA_VERSION,
  });
  const store: BranchStore = {
    getBranch: async () => snapshot(),
    updateBranchSnapshot: async (input) => {
      state = input.state;
      return true;
    },
    commitBranchMutation: async (input) => {
      state = input.state;
      return true;
    },
    deferUntilCommit: () => false,
  };
  const coordinator = createBranchCoordinator({ store });
  const docOf = () => {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, state);
    return doc;
  };
  const room = docOf();
  const draft = () => {
    const doc = docOf();
    const texts = textsOf(doc);
    doc.destroy();
    return texts;
  };
  const admit = (updateData: Uint8Array) =>
    coordinator.commitWriterUpdate({ branchId: BRANCH, updateData, roomDocument: room });

  let peer: Y.Doc | null = null;
  let undo: Y.UndoManager | null = null;
  const peerSaw = new Set<string>();
  let typedSinceSync = new Set<string>();
  const restored = new Set<string>();
  let writerClient = 2000;
  const frames: Uint8Array[] = [];
  const failures: string[] = [];

  const self = {
    draft,
    fork() {
      peer = new Y.Doc(); // the browser default: GC on, the Undo manager keeps what it needs
      Y.applyUpdate(peer, state);
      peer.clientID = 1000;
      undo = new Y.UndoManager(peer.getXmlFragment(FRAG), { captureTimeout: 0 });
      for (const t of tokensOf(textsOf(peer))) peerSaw.add(t);
    },
    peerTexts: () => (peer ? xmlTexts(peer) : []),
    /** One offline peer transaction; `typed` names the words it adds. */
    peerEdit(edit: (texts: Y.XmlText[]) => void, typed: readonly string[] = []) {
      if (!peer) throw new Error("no peer");
      const texts = xmlTexts(peer);
      peer.transact(() => edit(texts));
      for (const t of typed) {
        peerSaw.add(t);
        typedSinceSync.add(t);
      }
    },
    peerUndo() {
      undo?.undo();
    },
    async rebase(change: (texts: string[]) => string[]) {
      await coordinator.withLeases([BRANCH], (lease) =>
        coordinator.rewriteDraft(lease, BRANCH, async (doc) => {
          const next = change(textsOf(doc));
          doc.transact(
            () => writeBlocks(doc.getXmlFragment(FRAG), schema, next.map(para)),
            "rebase",
          );
          return { result: null };
        }),
      );
    },
    /** One edit by another writer who is current, admitted at once. A base word it types is a restore. */
    async writerEdit(edit: (texts: Y.XmlText[]) => void, typed: readonly string[] = []) {
      const writer = docOf();
      writer.clientID = writerClient++;
      let update: Uint8Array | null = null;
      writer.once("update", (u: Uint8Array) => {
        update = u;
      });
      writer.transact(() => edit(xmlTexts(writer)));
      writer.destroy();
      for (const t of typed) if (peerSaw.has(t)) restored.add(t);
      if (update) await admit(update);
    },
    /** The peer reconnects: its whole state past the server's vector, judged against the invariants. */
    async reconnect(label: string) {
      if (!peer) throw new Error("no peer");
      const frame = Y.encodeStateAsUpdate(peer, Y.encodeStateVectorFromUpdate(state));
      frames.push(frame);
      const before = draft();
      const visible = textsOf(peer);
      await admit(frame);
      const after = draft();
      const beforeText = before.join("\n");
      const afterText = after.join("\n");
      const fail = (what: string) =>
        failures.push(`${label}: ${what} ${JSON.stringify({ before, visible, after })}`);
      // (a) What the peer never saw survives: other writers' words, and words they wrote back.
      for (const t of tokensOf(before))
        if (!peerSaw.has(t) && !afterText.includes(t)) fail(`(a) erased ${t}`);
      for (const t of restored)
        if (countIn(afterText, t) < countIn(beforeText, t)) fail(`(a) erased restored ${t}`);
      // (b) Nothing absent from both the peer's text and the draft appears.
      const allowed = new Set([...tokensOf(before), ...tokensOf(visible)]);
      for (const t of tokensOf(after)) if (!allowed.has(t)) fail(`(b) invented ${t}`);
      // (c) Every word the peer typed that its text still shows reaches the draft, once.
      const shown = new Set(tokensOf(visible));
      for (const t of typedSinceSync)
        if (shown.has(t) && !afterText.includes(t)) fail(`(c) lost ${t}`);
      for (const t of typedSinceSync)
        if (countIn(afterText, t) > Math.max(1, countIn(beforeText, t)))
          fail(`(c) duplicated ${t}`);
      typedSinceSync = new Set();
    },
    /** A frame already admitted, again: never an instruction, so nothing changes. */
    async replay(label: string, frame = frames.at(-1)) {
      if (!frame) return;
      const before = draft();
      const outcome = await admit(frame);
      if (outcome.admitted || JSON.stringify(draft()) !== JSON.stringify(before))
        failures.push(
          `${label}: replay changed the draft ${JSON.stringify({ before, after: draft() })}`,
        );
    },
    frames,
    failures,
    dispose() {
      undo?.destroy();
      peer?.destroy();
      room.destroy();
      coordinator.dispose();
    },
  };
  return self;
}

type World = ReturnType<typeof world>;

/** The reviewed reproductions, as fixed histories (r5 S1, S2; K1-1). */
const FIXED: Record<string, (w: World) => Promise<void>> = {
  // S1: a frame with new typing plus the peer's old delete set erased words written since.
  async s1(w) {
    w.fork();
    w.peerEdit(
      ([t]) => {
        t.delete(0, 5);
        t.insert(0, "X");
      },
      ["X"],
    );
    await w.rebase(() => ["tail", "ALPHA beta gamma"]);
    await w.reconnect("s1 first");
    await w.writerEdit(
      (ts) => insertWord(ts.find((t) => t.toString().startsWith("ALPHA")) ?? ts[0], 0, "alpha"),
      ["alpha"],
    );
    await w.replay("s1 exact replay");
    w.peerEdit(([t]) => t.insert(t.length, " suffix"), ["suffix"]);
    await w.reconnect("s1 suffix");
  },
  // S2: words the offline writer typed and deleted again in the same frame came back.
  async s2(w) {
    w.fork();
    w.peerEdit(([t]) => t.insert(t.length, " transient"), ["transient"]);
    w.peerEdit(([t]) => t.delete(t.length - 10, 10));
    w.peerEdit(([t]) => t.insert(t.length, " final"), ["final"]);
    await w.rebase(() => ["tail", "ALPHA beta gamma"]);
    await w.reconnect("s2");
  },
  // K1-1: a replayed late deletion erased the word a writer typed back.
  async k1(w) {
    w.fork();
    w.peerEdit(([t]) => t.delete(6, 5));
    await w.rebase(() => ["tail", "ALPHA beta gamma"]);
    await w.reconnect("k1 first");
    await w.writerEdit((ts) => deleteWord(ts[1], 1));
    await w.writerEdit((ts) => insertWord(ts[1], 1, "beta"), ["beta"]);
    await w.replay("k1 replay");
    await w.reconnect("k1 reconnect");
  },
};

/** A random history: base words `b…`, live `l…`, other writer `w…`, peer `p…`, all unique. */
async function randomHistory(w: World, seed: number, fresh: (prefix: string) => string) {
  const r = rng(seed);
  const liveChange = (texts: string[]) => {
    const out = [...texts];
    for (let n = 1 + r.int(2); n > 0; n--) {
      const i = r.int(out.length);
      const words = out[i].split(" ");
      switch (r.int(5)) {
        case 0: // retype a word
          words[r.int(words.length)] = fresh("l");
          out[i] = words.join(" ");
          break;
        case 1: // delete the paragraph
          if (out.length > 1) out.splice(i, 1);
          break;
        case 2: // move it to the end
          out.push(...out.splice(i, 1));
          break;
        case 3: // a new paragraph
          out.splice(r.int(out.length + 1), 0, `${fresh("l")} ${fresh("l")}`);
          break;
        default: // split it
          if (words.length > 1) {
            const at = 1 + r.int(words.length - 1);
            out.splice(i, 1, words.slice(0, at).join(" "), words.slice(at).join(" "));
          }
      }
    }
    return out;
  };
  const peerEdits = async (count: number) => {
    for (let n = count; n > 0; n--) {
      const texts = w.peerTexts();
      if (!texts.length) return;
      const pick = r.int(texts.length);
      const at = r.int(8);
      const op = r.int(5);
      if (op <= 1) {
        const token = fresh("p");
        w.peerEdit((ts) => insertWord(ts[pick], at, token), [token]);
      } else if (op === 2) w.peerEdit((ts) => deleteWord(ts[pick], at));
      else if (op === 3) {
        // Retype after delete: the word goes, a new one takes its place.
        const token = fresh("p");
        w.peerEdit((ts) => deleteWord(ts[pick], at));
        w.peerEdit((ts) => insertWord(ts[pick], at % 3, token), [token]);
      } else w.peerUndo();
    }
  };
  const writerEdits = async (count: number) => {
    for (let n = count; n > 0; n--) {
      const at = r.int(8);
      const op = r.int(3);
      if (op === 0) {
        const token = fresh("w");
        await w.writerEdit(
          (ts) => ts.length && insertWord(ts[r.int(ts.length)], at, token),
          [token],
        );
      } else if (op === 1)
        await w.writerEdit((ts) => ts.length && deleteWord(ts[r.int(ts.length)], at));
      else {
        // Write back a base word the draft no longer shows (the S1 restore).
        const shown = new Set(tokensOf(w.draft()));
        const gone = [...baseWords].filter((t) => !shown.has(t));
        if (!gone.length) continue;
        const token = gone[r.int(gone.length)];
        await w.writerEdit(
          (ts) => ts.length && insertWord(ts[r.int(ts.length)], at, token),
          [token],
        );
      }
    }
  };
  const baseWords = new Set(tokensOf(w.draft()));

  if (r.chance(0.3)) await w.rebase(liveChange); // the peer forks after a first rebase
  w.fork();
  await peerEdits(1 + r.int(4));
  for (let n = 1 + r.int(2); n > 0; n--) await w.rebase(liveChange);
  if (r.chance(0.5)) await w.reconnect(`seed ${seed} early`);
  for (let round = 1 + r.int(3); round > 0; round--) {
    await writerEdits(r.int(3));
    if (r.chance(0.3)) await w.replay(`seed ${seed} replay`);
    if (r.chance(0.3)) await w.rebase(liveChange);
    await peerEdits(r.int(4));
    await w.reconnect(`seed ${seed} round ${round}`);
    if (r.chance(0.4)) await w.replay(`seed ${seed} twice`, undefined);
  }
}

const RANDOM_SEEDS = 120;

// Risk (D33; r5 S1, S2; K1-1, K1-2): a stale frame's old delete set erased newer writing, words it typed and
// deleted again came back, or recovery revived text the rebase deleted. Invariants on every admission:
// (a) words the peer never saw survive; (b) nothing absent from both the peer's text and the draft
// appears; (c) every word the peer typed that its text still shows reaches the draft, once. A replayed
// or repeated frame changes nothing, and no frame is refused.
it("admits stale peers without erasing, reviving or losing words, across fixed and seeded histories", async () => {
  const failures: string[] = [];
  const runs: Array<[string, readonly string[], (w: World) => Promise<void>]> = Object.entries(
    FIXED,
  ).map(([name, run]) => [name, ["alpha beta gamma", "tail"], run]);
  for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
    let next = 0;
    const fresh = (prefix: string) => `${prefix}${String(next++).padStart(3, "0")}`;
    const r = rng(seed * 7919);
    const base = Array.from({ length: 2 + r.int(3) }, () =>
      Array.from({ length: 2 + r.int(4) }, () => fresh("b")).join(" "),
    );
    runs.push([`seed ${seed}`, base, (w) => randomHistory(w, seed, fresh)]);
  }
  for (const [name, base, run] of runs) {
    const w = world(base);
    try {
      await run(w);
    } catch (cause) {
      failures.push(`${name}: ${String(cause)}`);
    }
    failures.push(...w.failures);
    w.dispose();
  }
  expect(failures).toEqual([]);
}, 30_000);
