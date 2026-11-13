/**
 * The real import graph of the source under the paths the map names, for check.mjs. Reads
 * source text, not types: it sees `import`/`export ... from`/dynamic `import()`/`require()` and a stylesheet's `@import`,
 * resolves relative paths, the configured aliases and workspace package names (`name[/sub]` is
 * the package's directory). Test files are
 * left out (with `test-support` directories and files): the map describes what the code does, not what its tests reach into.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx|css)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$|(?:^|\/)(?:__tests__|tests?|e2e|fixtures|test-support)\/|[^/]*test-support[^/]*$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".output", ".nitro", ".tanstack"]);
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".mts", ".cjs", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

const STATEMENTS = [
  // import a, { b } from "x" / import type ... from "x" / export ... from "x"
  /\b(?:import|export)\s+(type\s+)?([\w$*{},\s]*?)\s*\bfrom\s*["']([^"']+)["']/g,
  // import "x"
  /\bimport\s*["']([^"']+)["']/g,
  // import("x"), require("x")
  /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
];
// @import "x" in a stylesheet
const CSS_IMPORT = /@import\s+["']([^"']+)["']/g;

/** The module specifiers a file imports: [{ spec, typeOnly }]. Comments are blanked first, so a commented-out import doesn't count. */
function specifiersIn(source, isCss) {
  const found = [];
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const text = isCss ? noBlocks : noBlocks.replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");
  if (isCss) {
    for (const m of text.matchAll(CSS_IMPORT)) found.push({ spec: m[1], typeOnly: false });
    return found;
  }
  for (const m of text.matchAll(STATEMENTS[0])) {
    const names = m[2].trim();
    const specifiers = names.startsWith("{") ? names.slice(1, names.lastIndexOf("}")).split(",").map((n) => n.trim()).filter(Boolean) : [];
    const typeOnly = Boolean(m[1]) || (specifiers.length > 0 && specifiers.every((n) => n.startsWith("type ")));
    found.push({ spec: m[3], typeOnly });
  }
  for (const pattern of STATEMENTS.slice(1)) for (const m of text.matchAll(pattern)) found.push({ spec: m[1], typeOnly: false });
  return found;
}

/** Source files under a repo-relative directory or file, tests excluded. */
function sourceFiles(repo, path, out) {
  const full = join(repo, path);
  if (!existsSync(full)) return;
  if (statSync(full).isFile()) {
    if (SOURCE.test(path) && !TEST.test(path)) out.add(path);
    return;
  }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = posix.join(path, entry.name);
    if (entry.isDirectory()) sourceFiles(repo, child, out);
    else if (SOURCE.test(entry.name) && !TEST.test(child)) out.add(child);
  }
}

/** Package name → directory, for the workspace directories that hold a package.json. */
function workspacePackages(repo, workspaceDirs) {
  return new Map(workspaceDirs.map((dir) => [JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")).name, dir]));
}

/**
 * Imports out of the source under `roots` (repo-relative paths): [{ from, to, typeOnly }],
 * `to` a repo-relative file when the import resolves to one, else the path it points at; a
 * workspace package import has `to` the package directory. External packages are left out.
 * `workspaceDirs` are the directories of the workspace packages; `aliases` are
 * [{ prefix, within, to }]: a `prefix` import from a file under `within` reads from `to`.
 */
export function readImports(repo, roots, { workspaceDirs, aliases }) {
  const files = new Set();
  for (const root of roots) sourceFiles(repo, root, files);
  const packages = workspacePackages(repo, workspaceDirs);
  const isFile = (path) => {
    try {
      return statSync(join(repo, path)).isFile();
    } catch {
      return false;
    }
  };
  const settle = (path) => {
    // TypeScript sources import each other as "./x.js".
    const stem = path.replace(/\.[cm]?js$/, "");
    for (const candidate of stem === path ? [path] : [path, stem]) {
      for (const extension of EXTENSIONS) if (isFile(candidate + extension)) return candidate + extension;
    }
    return path;
  };
  const resolve = (from, spec) => {
    if (spec.startsWith(".")) return { to: settle(posix.normalize(posix.join(posix.dirname(from), spec))) };
    const alias = aliases.find((a) => spec.startsWith(a.prefix) && from.startsWith(a.within));
    if (alias) return { to: settle(alias.to + spec.slice(alias.prefix.length)) };
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    return packages.has(name) ? { to: packages.get(name) } : null;
  };

  const imports = [];
  for (const from of files) {
    const text = readFileSync(join(repo, from), "utf8");
    for (const { spec, typeOnly } of specifiersIn(text, from.endsWith(".css"))) {
      const target = resolve(from, spec);
      if (target && target.to !== from) imports.push({ from, typeOnly, ...target });
    }
  }
  return imports;
}

/** Whether `path` is `root` or lies under it. */
export const under = (path, root) => path === root || path.startsWith(`${root}/`);
