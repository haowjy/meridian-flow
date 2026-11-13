/**
 * The design tokens the page mirrors, resolved from packages/design-tokens (the only source of
 * these values). Light lives in `ink-jade.css`'s `@theme` block, which a browser ignores, so the
 * page carries a mirror (`styles/tokens.css`) and `check.mjs` fails when a value there differs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The tokens the page uses; add one here, then copy its resolved value into styles/tokens.css. */
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

export const TOKENS_DIR = "packages/design-tokens/src";

/** Custom properties declared in the blocks of `css` whose selector satisfies `wanted`. */
function declarations(css, wanted) {
  const props = {};
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!wanted(block[1].replace(/\s+/g, " ").trim())) continue;
    for (const decl of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      props[decl[1].slice(2)] = decl[2].replace(/\s+/g, " ").trim();
  }
  return props;
}

/** `var(--x)` replaced by its value in `scope`, until none is left. */
function resolve(value, scope) {
  let out = value;
  for (let i = 0; i < 8 && out.includes("var(--"); i++)
    out = out.replace(/var\(--([\w-]+)\)/g, (whole, name) => scope[name] ?? whole);
  return out;
}

/** { light, dark }: each the mirrored tokens by name (without `--`), resolved. */
export function expectedTokens(repo) {
  const read = (file) => readFileSync(join(repo, TOKENS_DIR, file), "utf8");
  const inkJade = read("ink-jade.css");
  const light = {
    ...declarations(inkJade, (s) => s === ":root" || s === "@theme"),
  };
  const darkOverrides = declarations(
    read("themes.css"),
    (s) => s.startsWith(':root[data-ui-theme="dark"]'),
  );
  const dark = { ...light, ...darkOverrides };
  const pick = (scope) =>
    Object.fromEntries(MIRRORED.map((name) => [name, resolve(scope[name] ?? "", scope)]));
  return { light: pick(light), dark: pick(dark) };
}
