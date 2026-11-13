/**
 * The design tokens the page mirrors, resolved from the project's token source (the only source of
 * these values; the config's `tokens` says where). A source may keep its light palette in a block
 * a browser ignores (Tailwind's `@theme`), so the page carries a mirror (the config's `styles`)
 * and `check.mjs` fails when a value there differs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The tokens page.css uses; add one here, then copy its resolved value into the project's styles file. */
export const MIRRORED = [
  "color-background",
  "color-foreground",
  "color-card",
  "color-card-foreground",
  "color-muted",
  "color-muted-foreground",
  "color-accent",
  "color-secondary",
  "color-border",
  "color-border-subtle",
  "color-ring",
  "color-primary",
  "color-primary-foreground",
  "color-jade-text",
  "color-destructive",
  "color-destructive-tint",
  "color-ink-subtle",
  "color-warning-bg",
  "color-warning-foreground",
  "color-code-surface",
  "color-code-foreground",
  "color-code-border",
  "shadow-card",
  "font-sans",
];

/** Custom properties by block, from a CSS file: selector text (whitespace-collapsed) to {name without `--`: value}. */
export function blocks(css) {
  const out = new Map();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, " ").trim();
    const props = {};
    for (const decl of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props[decl[1].slice(2)] = decl[2].replace(/\s+/g, " ").trim();
    out.set(selector, { ...out.get(selector), ...props });
  }
  return out;
}

/** Custom properties declared in the blocks of `css` whose selector satisfies `wanted`. */
function declarations(css, wanted) {
  const props = {};
  for (const [selector, declared] of blocks(css)) if (wanted(selector)) Object.assign(props, declared);
  return props;
}

/** `var(--x)` replaced by its value in `scope`, until none is left. */
function resolve(value, scope) {
  let out = value;
  for (let i = 0; i < 8 && out.includes("var(--"); i++)
    out = out.replace(/var\(--([\w-]+)\)/g, (whole, name) => scope[name] ?? whole);
  return out;
}

/**
 * { light, dark }: each the mirrored tokens by name (without `--`), resolved.
 * `source.light` = { file, selectors } (blocks whose selector is one of them);
 * `source.dark` = { file, selectorPrefix } (blocks whose selector starts with it), overriding light.
 */
export function expectedTokens(repo, source) {
  const read = (file) => readFileSync(join(repo, file), "utf8");
  const light = declarations(read(source.light.file), (s) => source.light.selectors.includes(s));
  const dark = { ...light, ...declarations(read(source.dark.file), (s) => s.startsWith(source.dark.selectorPrefix)) };
  const pick = (scope) => Object.fromEntries(MIRRORED.map((name) => [name, resolve(scope[name] ?? "", scope)]));
  return { light: pick(light), dark: pick(dark) };
}
