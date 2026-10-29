#!/usr/bin/env node
/**
 * Generates the target-scale project the grep recipe seeds (docs/qa/grep.md):
 * 150 chapters of 7,000 words and 300 KB entries of 800 words, 450 documents and about
 * 8.2M characters of synthetic xianxia prose. Deterministic. The output is large, so it is
 * generated, not committed:
 *
 *   node tools/mf/fixtures/grep-scale.mjs > tools/mf/fixtures/grep-scale.json
 *
 * Known frequencies the recipe's expected counts rest on: "Lin Feng" is in every document;
 * "Azure Dragon Seal" in exactly 9 (chapters 7, 19, 31, 43, 55, 67, 79, 91, 103); "Qi
 * Condensation 3" and "Qi Foundation 7" in every 10th chapter; "LIVE_ONLY" (escaped as
 * LIVE\_ONLY) only in chapter-001.
 */
const VOCABULARY = (
  "mountain gate river sword mist cloud dawn dusk temple elder disciple cultivation breath " +
  "pavilion lantern jade ember frost thunder valley bridge scroll formation array talisman " +
  "pill furnace beast stone path summit cavern spring blossom shadow whisper storm banner " +
  "courtyard hall sect master rival ally debt oath secret relic vein meridian core realm " +
  "tide ash silk copper iron bronze lotus pine moss crane tiger serpent drum bell flute " +
  "echo ridge fog lantern rain snow ember dust glimmer thread knot bowl cup tea ink brush"
).split(" ");
const NAMES = ["Lin Feng", "Su Yan", "Elder Mo", "Han Jue", "Bai Qing"];

let state = 20261027;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};
const pick = (list) => list[Math.floor(random() * list.length)];

function paragraph(words) {
  const out = [];
  for (let n = 0; n < words; n += 1)
    out.push(random() < 0.04 ? pick(NAMES.slice(1)) : pick(VOCABULARY));
  const text = out.join(" ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function body(title, words, inserts) {
  const paragraphs = [`# ${title}`, `Lin Feng walked on. ${inserts.join(" ")}`.trim()];
  for (let used = 0; used < words; used += 80)
    paragraphs.push(paragraph(Math.min(80, words - used)));
  return paragraphs.join("\n\n");
}

const docs = [];
const SEAL = new Set([7, 19, 31, 43, 55, 67, 79, 91, 103]);
for (let n = 1; n <= 150; n += 1) {
  const id = String(n).padStart(3, "0");
  const inserts = [];
  if (SEAL.has(n)) inserts.push("He found the Azure Dragon Seal beneath the altar.");
  if (n % 10 === 0) inserts.push("Qi Condensation 3 gave way to Qi Foundation 7.");
  if (n === 1) inserts.push("LIVE\\_ONLY marks this line.");
  docs.push({ uri: `manuscript://book/chapter-${id}`, text: body(`Chapter ${n}`, 7000, inserts) });
}
for (let n = 1; n <= 300; n += 1) {
  const id = String(n).padStart(3, "0");
  const folder = ["lore", "characters", "places"][n % 3];
  docs.push({ uri: `kb://${folder}/entry-${id}`, text: body(`Entry ${n}`, 800, []) });
}
console.log(
  JSON.stringify({ project: "default", overwrite: true, docs, thread: { title: "grep scale" } }),
);
