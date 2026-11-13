/**
 * The viewer's colours, read from the project's design token files (the config's `tokens.files`)
 * each time they are asked for: the custom property declarations of the blocks the config names,
 * as one stylesheet. A Tailwind `@theme` block, which a browser ignores, becomes `:root`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The top-level blocks of a stylesheet, comments removed: [{ selector, body }]. */
function topLevelBlocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth++ === 0) {
        selector = text.slice(start, i).replace(/\s+/g, " ").trim();
        start = i + 1;
      }
    } else if (c === "}") {
      if (--depth === 0) {
        blocks.push({ selector, body: text.slice(start, i) });
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) start = i + 1;
  }
  return blocks;
}

/**
 * The token stylesheet for `tokens` ({ files: [{ file, blocks }] }), read from the repo at `root`.
 * A block is taken when one of the selectors in its list is in `blocks` (`@theme` names the Tailwind block).
 * Returns { css, names: the property names without `--`, missing: "file: selector" for each listed block that isn't there }.
 */
export function readTokens(root, tokens) {
  const rules = [];
  const names = new Set();
  const missing = [];
  for (const { file, blocks: wanted } of tokens.files) {
    const found = new Set();
    for (const { selector, body } of topLevelBlocks(readFileSync(join(root, file), "utf8"))) {
      const hit = wanted.find((w) => selector.split(",").some((s) => s.trim() === w));
      if (!hit) continue;
      found.add(hit);
      const declarations = [...body.replace(/\{[^{}]*\}/g, "").matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)];
      for (const [, name] of declarations) names.add(name.slice(2));
      rules.push(`${hit === "@theme" ? ":root" : selector} {\n${declarations.map(([, name, value]) => `  ${name}: ${value.replace(/\s+/g, " ").trim()};`).join("\n")}\n}`);
    }
    for (const w of wanted) if (!found.has(w)) missing.push(`${file}: ${w}`);
  }
  return { css: `/* Built from ${tokens.files.map((f) => f.file).join(", ")}. */\n${rules.join("\n\n")}\n`, names, missing };
}
