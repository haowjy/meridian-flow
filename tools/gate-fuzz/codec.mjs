// The codec the fuzz runs on: Meridian's real node and mark specs through loro-prosemirror's whole-state binding.
// One change against the specs: each comment is its own mark type `comment_<id>` (Loro style key `comment_<id>`,
// expand none), which is the mapping design §1 gives the binding fork. Upstream 0.4.4 keys a style by mark type
// name, so two comments on one word would overwrite each other (gate 1d); a pool of per-id mark types stands in.
// Everything else (nodes, attrs, other marks) is `documentNodes` / `documentMarks` as `buildDocumentSchema` has them.
import { LoroDoc } from "loro-crdt";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import {
  buildDocumentSchema,
  documentMarks,
  documentNodes,
} from "../../packages/prosemirror-schema/src/index.ts";

export const ROOT = "doc";
export const COMMENT_POOL = 48;
// GATE_BINDING: a module path for the binding (default upstream loro-prosemirror@0.4.4).
export const BINDING = process.env.GATE_BINDING ?? "loro-prosemirror";
const { createNodeFromLoroObj, updateLoroToPmState } = await import(BINDING);

/** The real schema, as the server and the editor build it. */
export const realSchema = buildDocumentSchema();

/** True when the binding is our fork (gate/loro-binding), which maps `comment` marks to `comment_<id>` keys itself. */
export const FORK = BINDING.includes("binding-fork");

const { comment, suggest_ins, suggest_del, ...plainMarks } = documentMarks;
const commentMarks = {};
for (let i = 0; i < COMMENT_POOL; i++)
  commentMarks[`comment_c${i}`] = { attrs: {}, inclusive: false, excludes: "" };
/** The schema the binding reads and writes: the real one with the fork; with upstream, comments as one mark type per id. */
export const schema = FORK
  ? realSchema
  : new Schema({ nodes: documentNodes, marks: { ...plainMarks, ...commentMarks } });
/** The ProseMirror mark for comment `id` in `schema`. */
export const commentMark = (id) =>
  FORK ? schema.marks.comment.create({ id }) : schema.marks[`comment_${id}`].create();

/** Style config from the schema: a mark's `inclusive` is its expand; comment keys fall to the default, none. */
export const STYLES = Object.fromEntries(
  Object.entries(plainMarks).map(([name, spec]) => [
    name,
    { expand: spec.inclusive === false ? "none" : "after" },
  ]),
);
// Every document a script makes is freed when the script ends: a LoroDoc's WASM memory is not
// collected with its JS handle, and a run of 2,500 scripts otherwise grew to 2.5 GB.
const made = [];
export const track = (x) => (made.push(x), x);
export function freeAll() {
  for (const x of made.splice(0)) x.free();
}
export function configure(doc) {
  doc.configTextStyle(STYLES);
  doc.configDefaultTextStyle({ expand: "none" });
  return doc;
}
export function newDoc(peer) {
  const d = track(configure(new LoroDoc()));
  d.setPeerId(peer);
  return d;
}
export function forkOf(doc, peer) {
  const f = track(configure(doc.fork()));
  f.setPeerId(peer);
  return f;
}
export function copyOf(doc, peer) {
  const d = newDoc(peer);
  d.import(doc.export({ mode: "snapshot" }));
  return d;
}

// The binding drops a node the schema cannot build and logs it; in the fuzz that is a failure, not a log line.
const bindingErrors = [];
const origError = console.error;
console.error = (...args) => {
  bindingErrors.push(args.map(String).join(" ").slice(0, 300));
};
export function takeBindingErrors() {
  return bindingErrors.splice(0);
}
export function restoreConsole() {
  console.error = origError;
}

/** The document as ProseMirror (codec schema). */
export function read(doc) {
  return createNodeFromLoroObj(schema, doc.getMap(ROOT), new Map());
}

/** `pmDoc` with an id on every block that has none (a new document). */
export function withIds(pmDoc, rng) {
  const tr = EditorState.create({ schema, doc: pmDoc }).tr;
  fixBlockIds(tr, rng);
  return tr.doc;
}

/** Write a whole ProseMirror document into `doc` through the binding (one commit). */
export function writeDoc(doc, pmDoc, message) {
  const mapping = new Map();
  if (doc.getMap(ROOT).get("nodeName") != null)
    createNodeFromLoroObj(schema, doc.getMap(ROOT), mapping);
  if (message) doc.setNextCommitMessage(message);
  updateLoroToPmState(doc, mapping, EditorState.create({ schema, doc: pmDoc }));
}

/**
 * Edit `doc` through one ProseMirror transaction written by the binding, as an editor would: `fn(tr, doc)`
 * returns the transaction (or null for no edit). Block ids are fixed as `fix-block-ids.ts` does.
 */
export function edit(doc, fn, { message, rng } = {}) {
  const mapping = new Map();
  const pm = createNodeFromLoroObj(schema, doc.getMap(ROOT), mapping);
  const state = EditorState.create({ schema, doc: pm });
  const tr = fn(state.tr, state.doc);
  if (!tr || !tr.docChanged) return false;
  fixBlockIds(tr, rng);
  const next = state.apply(tr);
  if (message) doc.setNextCommitMessage(message);
  updateLoroToPmState(doc, mapping, next);
  return true;
}

const hasId = (node) => node.type.spec.attrs?.id !== undefined;
let idCounter = 0;
export function freshId(rng) {
  const A = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 10; i++) s += A[Math.floor((rng ? rng() : Math.random()) * 36)];
  return s + (idCounter++).toString(36);
}
/** The first block holding an id keeps it; a later copy (a split's second half, a paste) or a block with none gets a fresh one. */
export function fixBlockIds(tr, rng) {
  const seen = new Set();
  tr.doc.descendants((node, pos) => {
    if (!hasId(node)) return !node.isTextblock;
    const id = node.attrs.id;
    if (id == null || seen.has(id)) tr.setNodeAttribute(pos, "id", freshId(rng));
    else seen.add(id);
    return !node.isTextblock;
  });
}

// Codec ↔ real schema: `comment_<id>` mark types ↔ the real `comment` mark with `attrs.id`.
function mapMarks(json, fn) {
  if (Array.isArray(json)) return json.map((j) => mapMarks(j, fn));
  if (!json || typeof json !== "object") return json;
  const out = { ...json };
  if (json.marks) out.marks = json.marks.map(fn);
  if (json.content) out.content = mapMarks(json.content, fn);
  return out;
}
export const toRealJSON = (json) =>
  mapMarks(json, (m) =>
    m.type.startsWith("comment_") ? { type: "comment", attrs: { id: m.type.slice(8) } } : m,
  );
export const fromRealJSON = (json) =>
  mapMarks(json, (m) => (m.type === "comment" ? { type: `comment_${m.attrs.id}` } : m));
export const toReal = (node) => (FORK ? node : realSchema.nodeFromJSON(toRealJSON(node.toJSON())));
export const fromReal = (node) => (FORK ? node : schema.nodeFromJSON(fromRealJSON(node.toJSON())));

/** Throws unless the document is valid in the real schema (after the comment mapping). */
export function checkReal(doc) {
  const real = toReal(read(doc));
  real.check();
  return real;
}
