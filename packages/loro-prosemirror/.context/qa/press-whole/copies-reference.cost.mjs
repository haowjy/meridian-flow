// What the rules cost per Live update on a 200-word paragraph, with the reference's plain reads.
// Run: node .context/qa/press-whole/copies-reference.cost.mjs
import { docOf, forward, oneCopy, read, replace, T } from "./copies-reference.mjs";

const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
const live = docOf("1");
live.getText(T).insert(0, `${words} `);
live.commit();
const fork = docOf("2", live);
// A draft with 20 pending replacements, and 20 copies in its history (a Discard of 20 more).
for (let i = 0; i < 20; i++) replace(fork, `word${i * 5 + 1} `, `draft${i} `);
const time = (name, run, n) => {
  const start = performance.now();
  for (let i = 0; i < n; i++) run(i);
  console.log(`${name}: ${((performance.now() - start) / n).toFixed(2)} ms each (${n} runs)`);
};
time("forward of one Live key, no noted commit in the doc", (i) => {
  live.getText(T).insert(read(live).indexOf("word100") + 3, "x");
  live.commit();
  forward(fork, live);
}, 200);
// Live replaces a word the draft replaced: the fork answers, and the doc now holds noted commits.
for (let i = 0; i < 20; i++) {
  replace(live, `word${i * 5 + 1} `, `live${i} `);
  forward(fork, live);
}
time("forward of one Live key, 20 answers in the doc", () => {
  live.getText(T).insert(read(live).indexOf("word150") + 3, "x");
  live.commit();
  forward(fork, live);
}, 200);
time("oneCopy alone, 20 answers in the doc", () => oneCopy(fork), 200);
console.log(`fork ops: ${[...fork.oplogVersion().toJSON().values()].reduce((a, b) => a + b, 0)}, text ${read(fork).length} characters`);
