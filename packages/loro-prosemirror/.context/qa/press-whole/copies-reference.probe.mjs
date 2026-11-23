// Cases for copies-reference.mjs. Run: node .context/qa/press-whole/copies-reference.probe.mjs
// Each case prints what the draft and Live read, and fails on a text that is lost, twice or woven.
import { apply, discard, docOf, forward, oneCopy, read, replace, T, takeBack, undoApply } from "./copies-reference.mjs";

const S0 = "She tied herself to the mast.";
let failed = 0;
let peer = 100;
const next = () => String(peer++);

function start(base = S0) {
  const live = docOf(next());
  live.getText(T).insert(0, base);
  live.commit();
  return live;
}

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: "${got}"${ok ? "" : `  (want "${want}")`}`);
}

/** Type `put` into `doc` at the first `after`, one commit a key, with `each` run after every key. */
function type(doc, after, put, each = () => {}) {
  let at = read(doc).indexOf(after) + after.length;
  for (const ch of put) {
    doc.getText(T).insert(at++, ch);
    doc.commit();
    each();
  }
}

console.log("# 1. Live typing outside the stretch the draft replaced survives Apply");
{
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied", "lashed");
  type(live, "tied", " tightly", () => forward(fork, live));
  type(live, "the ", "main", () => forward(fork, live));
  replace(live, "She", "Anna");
  forward(fork, live);
  check("draft", read(fork), "Anna lashed tightly herself to the mainmast.");
  check("Live before", read(live), "Anna tied tightly herself to the mainmast.");
  apply(fork, live);
  check("Live after Apply", read(live), "Anna lashed tightly herself to the mainmast.");
}

console.log("# 1b. Live typing at the leading edge survives (its order beside the draft's word is Loro's)");
for (const [f, l] of [[1, 2], [2, 1]]) {
  const live = docOf(String(900 + l));
  live.getText(T).insert(0, S0);
  live.commit();
  const fork = docOf(String(900 + f), live);
  replace(fork, "tied", "lashed");
  type(live, "She ", "all ", () => forward(fork, live));
  apply(fork, live);
  const got = read(live);
  const ok = got.includes("all ") && got.includes("lashed") && !got.includes("tied");
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} Live after Apply (peers ${f}/${l}): "${got}"`);
}

console.log("# 2. Both sides replaced the same word: Apply gives the draft's wording");
for (const keys of [false, true]) {
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied", "lashed");
  if (keys) {
    replace(live, "tied", "b");
    forward(fork, live);
    type(live, "b", "ound", () => forward(fork, live));
  } else {
    replace(live, "tied", "bound");
    forward(fork, live);
  }
  const how = keys ? "typed key by key" : "one commit";
  check(`draft (${how})`, read(fork), "She lashed herself to the mast.");
  check(`Live before (${how})`, read(live), "She bound herself to the mast.");
  apply(fork, live);
  check(`Live after Apply (${how})`, read(live), "She lashed herself to the mast.");
}

console.log("# 3. The hard case: Live replaced a wider phrase than the draft");
for (const keys of [false, true]) {
  const live = start();
  const fork = docOf(next(), live);
  const stats = {};
  replace(fork, "tied", "lashed");
  if (keys) {
    replace(live, "tied herself", "b");
    forward(fork, live, stats);
    type(live, "b", "ound himself", () => forward(fork, live, stats));
  } else {
    replace(live, "tied herself", "bound himself");
    forward(fork, live, stats);
  }
  const how = keys ? "typed key by key" : "one commit";
  check(`draft (${how})`, read(fork), "She lashed herself to the mast.");
  check(`Live before (${how})`, read(live), "She bound himself to the mast.");
  apply(fork, live);
  check(`Live after Apply (${how})`, read(live), "She lashed herself to the mast.");
  console.log(`     clashes ${stats.clashes ?? 0}, put-backs ${stats.putBack ?? 0}`);
}

console.log("# 3b. The same, and Live goes on typing after its phrase");
{
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied", "lashed");
  replace(live, "tied herself", "bound himself");
  forward(fork, live);
  type(live, "himself", " again", () => forward(fork, live));
  check("draft", read(fork), "She lashed herself to the mast.");
  check("Live", read(live), "She bound himself again to the mast.");
  type(live, "mast", "head", () => forward(fork, live));
  check("draft, Live typing elsewhere", read(fork), "She lashed herself to the masthead.");
}

console.log("# 4. Several writers: two copies of the fork each answer the same Live edit");
{
  const live = start();
  const room = docOf(next(), live);
  replace(room, "tied", "lashed");
  const tab = docOf(next(), room);
  const [roomLive, tabLive] = [docOf(next(), live), docOf(next(), live)];
  replace(live, "tied herself", "bound himself");
  for (const copy of [roomLive, tabLive]) copy.import(live.export({ mode: "update" }));
  forward(room, roomLive);
  forward(tab, tabLive);
  check("room copy alone", read(room), "She lashed herself to the mast.");
  check("tab copy alone", read(tab), "She lashed herself to the mast.");
  room.import(tab.export({ mode: "update" }));
  oneCopy(room);
  tab.import(room.export({ mode: "update" }));
  oneCopy(tab);
  check("room after sync", read(room), "She lashed herself to the mast.");
  check("tab after sync", read(tab), "She lashed herself to the mast.");
  // Both answer the duplicate at once, then meet.
  const [a, b] = [docOf(next(), live), docOf(next(), live)];
  for (const copy of [a, b]) {
    copy.import(room.export({ mode: "update" }));
    copy.import(tab.export({ mode: "update" }));
  }
  const rawA = docOf(next(), a);
  oneCopy(a);
  oneCopy(b);
  a.import(b.export({ mode: "update" }));
  oneCopy(a);
  check("two copies that each took the duplicate out", read(a), "She lashed herself to the mast.");
  void rawA;
  apply(room, live);
  check("Live after Apply", read(live), "She lashed herself to the mast.");
}

console.log("# 5. The draft replaced the wider phrase");
{
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied herself", "lashed them");
  replace(live, "tied", "bound");
  forward(fork, live);
  check("draft", read(fork), "She lashed them to the mast.");
  apply(fork, live);
  check("Live after Apply", read(live), "She lashed them to the mast.");
}

console.log("# 6. Live only deleted, wider than the draft: Live's delete stands");
{
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied", "lashed");
  replace(live, "tied herself ", "");
  forward(fork, live);
  check("draft", read(fork), "She lashedto the mast.");
}

console.log("# 7. Live typed inside the word the draft replaced");
{
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied", "lashed");
  type(live, "ti", "x", () => forward(fork, live));
  check("draft", read(fork), "She lashed herself to the mast.");
  check("Live", read(live), "She tixed herself to the mast.");
  apply(fork, live);
  check("Live after Apply", read(live), "She lashed herself to the mast.");
}

console.log("# 8. Live takes its own replacement back after the fork kept it out");
{
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied", "lashed");
  const before = live.frontiers();
  replace(live, "tied herself", "bound himself");
  const pressed = { before, after: live.frontiers() };
  forward(fork, live);
  takeBack(live, pressed);
  forward(fork, live);
  check("Live", read(live), S0);
  check("draft", read(fork), "She lashed herself to the mast.");
  apply(fork, live);
  check("Live after Apply", read(live), "She lashed herself to the mast.");
}

console.log("# 9. fFirst: two drafts deleted one letter, both applied, both undone");
{
  const live = start("First.");
  const [a, b] = [docOf(next(), live), docOf(next(), live)];
  replace(a, "F", "A rewrote f");
  replace(b, "F", "B rewrote f");
  const pa = apply(a, live);
  const pb = apply(b, live);
  console.log(`     Live after both: "${read(live)}"`);
  undoApply(b, live, pb);
  forward(a, live);
  undoApply(a, live, pa);
  check("Live after both Undos", read(live), "First.");
  forward(b, live);
  check("draft B", read(b), "B rewrote first.");
  check("draft A", read(a), "A rewrote first.");
  apply(b, live);
  check("Live after B applied again", read(live), "B rewrote first.");
}

console.log("# 10. lashedtied: a draft holds put-back text Live then replaces");
{
  const live = start();
  const [main, darker] = [docOf(next(), live), docOf(next(), live)];
  replace(main, "tied", "knotted");
  discard(main, live);
  check("Main after Discard", read(main), S0);
  replace(darker, "tied", "lashed");
  type(darker, "mast", " and waited");
  apply(darker, live);
  apply(main, live);
  check("Live after Apply all", read(live), "She lashed herself to the mast and waited.");
  check("Main", read(main), "She lashed herself to the mast and waited.");
}

console.log("# 11. N7: Live deletes a word inside text a Discard put back in the fork");
{
  const live = start();
  const fork = docOf(next(), live);
  replace(fork, "tied herself to", "sat by");
  discard(fork, live);
  replace(live, "herself ", "");
  forward(fork, live);
  check("draft", read(fork), "She tied to the mast.");
  check("Live", read(live), "She tied to the mast.");
}

console.log(failed === 0 ? "\nall cases pass" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
